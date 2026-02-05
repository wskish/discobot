import tsParser from "@typescript-eslint/parser";
import reactCompiler from "eslint-plugin-react-compiler";

export default [
	{
		// Ignore build outputs, dependencies, and Go code
		ignores: [
			"dist/**",
			"node_modules/**",
			"server/**",
			"proxy/**",
			"agent/**",
			"agent-api/**",
			".claude/**",
			".cursor/**",
			".opencode/**",
			".next/**",
			"scripts/**",
		],
	},
	{
		files: ["**/*.{js,jsx,ts,tsx}"],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				ecmaVersion: "latest",
				sourceType: "module",
				ecmaFeatures: {
					jsx: true,
				},
			},
		},
		plugins: {
			"react-compiler": reactCompiler,
		},
		rules: {
			"react-compiler/react-compiler": "error",
		},
	},
];
