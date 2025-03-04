import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import { Connection, Request as SqlRequest, TYPES } from "tedious";

interface WeeklyAttendance {
  iso: number;
  attendance: string;
}

interface PersonAttendance {
  name: string;
  level: string;
  weeks: { [weekRange: string]: WeeklyAttendance };
}

export async function getAttendanceHandler(req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("Invocation started for getAttendance Azure Function.");

  const kvUri = "https://helix-keys.vault.azure.net/";
  const passwordSecretName = "sql-databaseserver-password";
  const sqlServer = "helix-database-server.database.windows.net";

  const projectDataDb = "helix-project-data";
  const coreDataDb = "helix-core-data";

  try {
    // 1) Retrieve SQL password from Azure Key Vault
    const secretClient = new SecretClient(kvUri, new DefaultAzureCredential());
    const passwordSecret = await secretClient.getSecret(passwordSecretName);
    const password = passwordSecret.value || "";
    context.log("Retrieved SQL password from Key Vault.");

    // 2) Parse SQL connection configs
    const projectDataConfig = parseConnectionString(
      `Server=${sqlServer};Database=${projectDataDb};User ID=helix-database-server;Password=${password};Encrypt=true;TrustServerCertificate=false;`,
      context
    );
    const coreDataConfig = parseConnectionString(
      `Server=${sqlServer};Database=${coreDataDb};User ID=helix-database-server;Password=${password};Encrypt=true;TrustServerCertificate=false;`,
      context
    );

    // 3) Determine date ranges (Previous, Current, Next)
    const todayDate = new Date();
    const currentWeekStart = getStartOfWeek(todayDate);
    const currentWeekEnd   = getEndOfWeek(currentWeekStart);
    const currentWeekRange = formatWeekRange(currentWeekStart, currentWeekEnd);

    const nextWeekStart = getNextWeekStart(currentWeekStart);
    const nextWeekEnd   = getEndOfWeek(nextWeekStart);
    const nextWeekRange = formatWeekRange(nextWeekStart, nextWeekEnd);

    // For fallback: previous week range
    const previousWeekStart = new Date(currentWeekStart);
    previousWeekStart.setDate(previousWeekStart.getDate() - 7);
    const previousWeekEnd = getEndOfWeek(previousWeekStart);
    const previousWeekRange = formatWeekRange(previousWeekStart, previousWeekEnd);

    // Determine the day to check (e.g. "Monday", "Tuesday", etc.)
    const dayToCheckDate = todayDate; // or use getNextWorkingDay(todayDate)
    const dayToCheck = dayToCheckDate.toLocaleDateString("en-GB", { weekday: "long" });

    context.log(`Previous Week Range: ${previousWeekRange}`);
    context.log(`Current Week Range: ${currentWeekRange}`);
    context.log(`Next Week Range: ${nextWeekRange}`);
    context.log(`Day to check: ${dayToCheck}`);

    // 4) Query the attendance data with the updated query and format
    const attendees: PersonAttendance[] = await queryAttendance(
      previousWeekRange,
      currentWeekRange,
      nextWeekRange,
      dayToCheck,
      projectDataConfig,
      context
    );

    // 5) Query your team data (unchanged)
    const teamData = await queryTeamData(coreDataConfig, context);

    return {
      status: 200,
      body: JSON.stringify({
        attendance: attendees,
        team: teamData
      })
    };
  } catch (error) {
    context.error("Error retrieving attendance data:", error);
    return {
      status: 500,
      body: "Error retrieving attendance data."
    };
  } finally {
    context.log("Invocation completed for getAttendance Azure Function.");
  }
}

// Revised queryAttendance function returning weekly data per person
async function queryAttendance(
  previousWeekRange: string,
  currentWeekRange: string,
  nextWeekRange: string,
  day: string,
  config: any,
  context: InvocationContext
): Promise<PersonAttendance[]> {
  return new Promise((resolve, reject) => {
    const connection = new Connection(config);

    connection.on("error", (err) => {
      context.error("SQL Connection Error (Attendance):", err);
      reject("An error occurred with the SQL connection.");
    });

    connection.on("connect", (err) => {
      if (err) {
        context.error("SQL Connection Error (Attendance):", err);
        reject("Failed to connect to SQL database.");
        return;
      }

      context.log("Successfully connected to SQL database (Attendance).");

      // Updated query to also select Current_ISO and Next_ISO fields
      const query = `
        SELECT 
          [First_Name] AS name, 
          [Current_Attendance] AS current_attendance,
          [Current_Week] AS current_week,
          [Current_ISO] AS current_iso,
          [Next_Attendance] AS next_attendance,
          [Next_Week] AS next_week,
          [Next_ISO] AS next_iso,
          [Level],
          [Entry_ID]
        FROM [dbo].[officeAttendance-clioCalendarEntries]
        WHERE 
          [Current_Week] = @CurrentWeek
          OR
          [Next_Week] = @NextWeek
          OR
          (
            [Next_Week] = @CurrentWeek
            AND [Current_Week] = @PreviousWeek
          )
        ORDER BY [First_Name];
      `;
      context.log("SQL Query (Attendance):", query);

      const sqlRequest = new SqlRequest(query, (err, rowCount) => {
        if (err) {
          context.error("SQL Query Execution Error (Attendance):", err);
          reject("SQL query failed.");
          connection.close();
          return;
        }
        context.log(`SQL query executed successfully (Attendance). Rows returned: ${rowCount}`);
      });

      // Build a map keyed by person's name to combine weekly data
      const attendanceMap: { [name: string]: PersonAttendance } = {};

      sqlRequest.on("row", (columns) => {
        const name = (columns.find(c => c.metadata.colName === "name")?.value as string) || "";
        const level = (columns.find(c => c.metadata.colName === "Level")?.value as string) || "";
        const currentWeek = (columns.find(c => c.metadata.colName === "current_week")?.value as string) || "";
        const currentAttendance = (columns.find(c => c.metadata.colName === "current_attendance")?.value as string) || "";
        const nextWeek = (columns.find(c => c.metadata.colName === "next_week")?.value as string) || "";
        const nextAttendance = (columns.find(c => c.metadata.colName === "next_attendance")?.value as string) || "";
        const currentISO = (columns.find(c => c.metadata.colName === "current_iso")?.value as number) || 0;
        const nextISO = (columns.find(c => c.metadata.colName === "next_iso")?.value as number) || 0;

        if (!attendanceMap[name]) {
          attendanceMap[name] = {
            name,
            level,
            weeks: {}
          };
        }
        // Add or update current week data if available
        if (currentWeek) {
          attendanceMap[name].weeks[currentWeek] = {
            iso: currentISO,
            attendance: currentAttendance
          };
        }
        // Add or update next week data if available
        if (nextWeek) {
          attendanceMap[name].weeks[nextWeek] = {
            iso: nextISO,
            attendance: nextAttendance
          };
        }
      });

      sqlRequest.on("requestCompleted", () => {
        const results = Object.values(attendanceMap);
        // Optionally sort the results by name
        results.sort((a, b) => a.name.localeCompare(b.name));
        context.log("Weekly Attendance Data:", results);
        resolve(results);
        connection.close();
      });

      // Bind parameters
      sqlRequest.addParameter("PreviousWeek", TYPES.NVarChar, previousWeekRange);
      sqlRequest.addParameter("CurrentWeek", TYPES.NVarChar, currentWeekRange);
      sqlRequest.addParameter("NextWeek", TYPES.NVarChar, nextWeekRange);

      context.log("Executing SQL query with parameters (Attendance):", {
        PreviousWeek: previousWeekRange,
        CurrentWeek: currentWeekRange,
        NextWeek: nextWeekRange
      });

      connection.execSql(sqlRequest);
    });

    connection.connect();
  });
}

// (Team query function remains unchanged)
async function queryTeamData(config: any, context: InvocationContext): Promise<{ First: string; Initials: string; ["Entra ID"]: string; Nickname?: string }[]> {
  return new Promise((resolve, reject) => {
    const connection = new Connection(config);

    connection.on("error", (err) => {
      context.error("SQL Connection Error (Team):", err);
      reject("An error occurred with the SQL connection.");
    });

    connection.on("connect", (err) => {
      if (err) {
        context.error("SQL Connection Error (Team):", err);
        reject("Failed to connect to SQL database.");
        return;
      }

      context.log("Successfully connected to SQL database (Team).");

      const query = `
        SELECT [First], [Initials], [Entra ID], [Nickname] 
        FROM [dbo].[team] 
        WHERE [status] <> 'inactive';
      `;
      context.log("SQL Query (Team):", query);

      const sqlRequest = new SqlRequest(query, (err, rowCount) => {
        if (err) {
          context.error("SQL Query Execution Error (Team):", err);
          reject("SQL query failed.");
          connection.close();
          return;
        }
        context.log(`SQL query executed successfully (Team). Rows returned: ${rowCount}`);
      });

      const teamData: { First: string; Initials: string; ["Entra ID"]: string; Nickname?: string }[] = [];

      sqlRequest.on("row", (columns) => {
        const obj: any = {};
        columns.forEach((col) => {
          obj[col.metadata.colName] = col.value;
        });
        teamData.push(obj);
      });

      sqlRequest.on("requestCompleted", () => {
        context.log("Team Data Retrieved:", teamData);
        resolve(teamData);
        connection.close();
      });

      connection.execSql(sqlRequest);
    });

    connection.connect();
  });
}

// Utility functions (unchanged except for context)
function parseConnectionString(connectionString: string, context: InvocationContext): any {
  const parts = connectionString.split(";");
  const config: any = {};

  parts.forEach((part) => {
    const [key, value] = part.split("=");
    if (!key || !value) return;

    switch (key.trim()) {
      case "Server":
        config.server = value;
        break;
      case "Database":
        config.options = { ...config.options, database: value };
        break;
      case "User ID":
        config.authentication = { type: "default", options: { userName: value, password: "" } };
        break;
      case "Password":
        if (!config.authentication) {
          config.authentication = { type: "default", options: { userName: "", password: "" } };
        }
        config.authentication.options.password = value;
        break;
      case "Encrypt":
        config.options = { ...config.options, encrypt: value.toLowerCase() === "true" };
        break;
      case "TrustServerCertificate":
        config.options = { ...config.options, trustServerCertificate: value.toLowerCase() === "true" };
        break;
      case "Connect Timeout":
        config.options = { ...config.options, connectTimeout: parseInt(value, 10) };
        break;
      default:
        break;
    }
  });

  return config;
}

function getStartOfWeek(date: Date): Date {
  const day = date.getDay(); // 0=Sunday, 1=Monday, ...
  const diff = (day === 0 ? -6 : 1) - day; // Adjust so that Monday is the first day
  const start = new Date(date);
  start.setDate(date.getDate() + diff);
  start.setHours(0, 0, 0, 0);
  return start;
}

function getNextWeekStart(currentWeekStart: Date): Date {
  const nextWeekStart = new Date(currentWeekStart);
  nextWeekStart.setDate(currentWeekStart.getDate() + 7);
  nextWeekStart.setHours(0, 0, 0, 0);
  return nextWeekStart;
}

function getEndOfWeek(startDate: Date): Date {
  const end = new Date(startDate);
  end.setDate(startDate.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return end;
}

function formatWeekRange(start: Date, end: Date): string {
  const options: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: 'numeric' };
  const startStr = start.toLocaleDateString("en-GB", options);
  const endStr = end.toLocaleDateString("en-GB", options);
  return `Monday, ${startStr} - Sunday, ${endStr}`;
}

function attendanceIncludesDay(attendance: string, day: string): boolean {
  if (!attendance) return false;
  const days = attendance.split(",").map(d => d.trim().toLowerCase());
  return days.includes(day.toLowerCase());
}

function getNextWorkingDay(date: Date): Date {
  const nextDay = new Date(date);
  nextDay.setDate(date.getDate() + 1);
  while (nextDay.getDay() === 0 || nextDay.getDay() === 6) {
    nextDay.setDate(nextDay.getDate() + 1);
  }
  nextDay.setHours(0, 0, 0, 0);
  return nextDay;
}

export default app.http("getAttendance", {
  methods: ["POST"],
  authLevel: "function",
  handler: getAttendanceHandler,
});
