
    // @ts-check
    
    import eslint from '@eslint/js';
    import tseslint from 'typescript-eslint';
    import nextPlugin from '@next/eslint-plugin-next';
    import reactPlugin from 'eslint-plugin-react';
    import reactHooksPlugin from 'eslint-plugin-react-hooks';
    import globals from 'globals';
    
    export default tseslint.config(
      {
        ignores: [
          "node_modules/",
          ".next/",
          "out/",
          "functions/lib/",
          "**/*.config.js", // Ignoring config files like tailwind.config.js, postcss.config.js
          "**/*.config.ts", // Ignoring config files like tailwind.config.ts
          "components.json",
          "firebase.json",
          "firestore.rules",
          "storage.rules",
          "firestore.indexes.json",
          ".vscode/",
          "scripts/seedEmulator.ts", // Ignoring seed script for now
          "src/ai/dev.ts", // Ignoring genkit dev script
          "src/components/ui/sidebar.tsx", // Ignoring complex UI component for now
          "src/components/ui/chart.tsx", // Ignoring complex UI component for now
        ],
      },
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
      {
        plugins: {
          '@next/next': nextPlugin,
          'react': reactPlugin,
          'react-hooks': reactHooksPlugin,
        },
        rules: {
          ...nextPlugin.configs.recommended.rules,
          ...nextPlugin.configs['core-web-vitals'].rules,
          'react/react-in-jsx-scope': 'off', // Next.js handles React import
          'react/prop-types': 'off', // Prefer TypeScript for prop types
          'react-hooks/rules-of-hooks': 'error',
          'react-hooks/exhaustive-deps': 'warn',
          '@typescript-eslint/no-unused-vars': [
            'warn',
            { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
          ],
          '@typescript-eslint/no-explicit-any': 'warn',
          // Add any project-specific rules here
          "prefer-const": "warn",
          "no-console": ["warn", { "allow": ["warn", "error", "info"] }], // Allow console.warn, .error, .info
        },
        languageOptions: {
          globals: {
            ...globals.browser,
            ...globals.node,
            ...globals.es2021,
            React: 'readonly', // Add React to globals
          },
          parserOptions: {
            project: ['./tsconfig.json', './functions/tsconfig.json'],
            tsconfigRootDir: import.meta.dirname,
          },
        },
        settings: {
          react: {
            version: 'detect',
          },
        },
      }
    );
    