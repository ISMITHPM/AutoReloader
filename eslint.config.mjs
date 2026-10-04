import globals from "globals";

export default [
  {
    files: ["*.js"],
    ignores: ["eslint.config.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: {
        ...globals.browser,
        chrome: "readonly",
      },
    },
    rules: {
      "no-unused-vars": "warn",
      "no-undef": "error",
      "no-redeclare": "error",
      "no-unreachable": "error",
    },
  },
];
