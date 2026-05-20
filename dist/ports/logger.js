/**
 * StructuredLogger — sole logging seam for core/.
 *
 * Outer layers wire a concrete logger (console, pino, file-append). Tests
 * substitute a recording logger. core/ never calls console.log directly.
 */
export {};
//# sourceMappingURL=logger.js.map