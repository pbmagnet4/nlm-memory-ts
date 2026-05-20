/**
 * StructuredLogger — sole logging seam for core/.
 *
 * Outer layers wire a concrete logger (console, pino, file-append). Tests
 * substitute a recording logger. core/ never calls console.log directly.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogFields {
    readonly [key: string]: string | number | boolean | null | undefined;
}
export interface StructuredLogger {
    log(level: LogLevel, message: string, fields?: LogFields): void;
}
