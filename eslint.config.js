// Flat config for ESLint 9.
//
// The package.json declared "lint": "eslint src/" and listed eslint as a
// devDependency, but the repo had no config file at all. ESLint 9 requires a
// flat config, so the lint script could never run — which is one reason the
// three P0 bugs below went unnoticed. This config is intentionally
// self-contained (no @eslint/js import) so it works on a bare install.
//
// Note: the non-standard "allowScripts" key in package.json is not read by
// npm; it only means the native better-sqlite3 build is skipped by some
// package managers. See README for the install notes.
export default [
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        URL: "readonly",
        global: "readonly",
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      "no-unused-vars": ["warn", { args: "none" }],
      "no-undef": "error",
      "no-var": "error",
      "prefer-const": "warn",
      eqeqeq: ["warn", "smart"],
      "no-console": "off",
    },
  },
];
