import pkg from "../package.json" with { type: "json" };

/** This termium's version (package.json; built into release binaries). */
export const VERSION: string = pkg.version;
