import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "dist/**", "build/**", "coverage/**"],
  },
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/tui/*"],
              message: "Non-TUI modules must not depend on the TUI layer.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/tui/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  {
    files: ["src/resources/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/engine/*", "@/runtime/*", "@/tui/*", "@/workflows/*"],
              message: "Resource modules must stay below engine/runtime/workflow/UI layers.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/runtime/middleware.ts", "src/runtime/services.ts", "src/runtime/toolPolicy.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/engine/*", "@/tui/*", "@/workflows/*"],
              message: "Runtime modules must not depend on engine, workflow, or UI layers.",
            },
          ],
        },
      ],
    },
  },
);
