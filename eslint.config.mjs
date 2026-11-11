import js from "@eslint/js";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const sourceFiles = ["src/**/*.{ts,tsx}"];

export default tseslint.config(
  {
    ignores: ["**/.artifacts/**", "**/build/**", "**/dist/**", "**/node_modules/**", "**/out/**"],
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  {
    files: ["**/*.mjs"],
    ...js.configs.recommended,
    languageOptions: {
      ...js.configs.recommended.languageOptions,
      globals: {
        Buffer: "readonly",
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setImmediate: "readonly",
        structuredClone: "readonly",
        URL: "readonly",
      },
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
  })),
  {
    files: ["src/**/*.{ts,tsx,mjs}", "scripts/**/*.mjs", "*.{ts,mjs}"],
    plugins: {
      "@eslint-community/eslint-comments": eslintComments,
    },
    rules: {
      "@eslint-community/eslint-comments/require-description": "error",
    },
  },
  {
    files: sourceFiles,
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.renderer.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    ignores: [
      "src/renderer/components/ui/Button.tsx",
      "src/renderer/components/ui/Input.tsx",
      "src/renderer/components/ui/Textarea.tsx",
      // The composer textarea owns autosize and IME composition handling.
      "src/renderer/components/ChatInput.tsx",
    ],
    rules: {
      // Button colors live in the shared .pi-btn classes; compose them through
      // <Button> instead of re-typing the class names at call sites. Raw
      // <button> elements are reserved to the Button component itself. Text
      // inputs, textareas and selects route through ui/Input, ui/Textarea and
      // ui/Select; checkboxes stay native until a Checkbox component exists.
      "no-restricted-syntax": [
        "error",
        {
          selector: 'JSXAttribute[name.name="className"][value.value=/pi-btn/] , Literal[value=/\\bpi-btn/]',
          message: "Use <Button> from components/ui/Button instead of pi-btn class literals.",
        },
        {
          selector: 'JSXOpeningElement[name.name="button"]',
          message: "Use <Button> from components/ui/Button instead of raw <button> elements.",
        },
        {
          selector: 'JSXOpeningElement[name.name="select"]',
          message: "Use <Select> from components/ui/Select instead of raw <select> elements.",
        },
        {
          selector: 'JSXOpeningElement[name.name="textarea"]',
          message: "Use <Textarea> from components/ui/Textarea instead of raw <textarea> elements.",
        },
        {
          selector:
            'JSXOpeningElement[name.name="input"] JSXAttribute[name.name="type"][value.value=/^(text|password|number|search)$/] , JSXOpeningElement[name.name="input"]:not(:has(JSXAttribute[name.name="type"]))',
          message: "Use <Input> from components/ui/Input instead of raw text-like <input> elements.",
        },
      ],
    },
  },
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  prettier,
);
