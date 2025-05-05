module.exports = {
  root: true,
  env: {
    es6: true,
    node: true,
  },
  extends: [
    "eslint:recommended",
    "plugin:import/errors",
    "plugin:import/warnings",
    "plugin:import/typescript",
    "google",
    "plugin:@typescript-eslint/recommended",
  ],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: ["tsconfig.json", "tsconfig.dev.json"],
    sourceType: "module",
    tsconfigRootDir: __dirname,
  },
  ignorePatterns: [
    "/lib/**/*", // Ignore built files.
  ],
  plugins: [
    "@typescript-eslint",
    "import",
  ],
  rules: {
    "quotes": ["error", "double"],
    "import/no-unresolved": 0,
    "indent": ["error", 2],
    "object-curly-spacing": ["error", "never"], // Disallow spaces inside braces
    "max-len": ["error", {"code": 120}], // Set max line length to 120
    "@typescript-eslint/no-explicit-any": "warn", // Warn instead of error for 'any'
    "@typescript-eslint/no-unused-vars": ["warn", {"argsIgnorePattern": "^_"}], // Warn for unused vars, ignore args starting with _
    "require-jsdoc": "off", // Disable requiring JSDoc
    "valid-jsdoc": "off", // Disable validating JSDoc
  },
};
