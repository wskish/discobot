const isTauri = process.env.NEXT_PUBLIC_TAURI === "true";
const isDev = process.env.NODE_ENV === "development";
const isTauriBuild = isTauri && !isDev;

/** @type {import('next').NextConfig} */
const nextConfig = {
	// Disable compression for SSE streaming compatibility
	compress: false,
	typescript: {
		ignoreBuildErrors: true,
	},
	images: {
		unoptimized: true,
	},
	// Use separate build directories for Tauri vs regular dev
	...(isTauriBuild && {
		output: "export",
		distDir: "dist",
	}),
	...(isTauri &&
		isDev && {
			distDir: ".next-tauri",
		}),
};

export default nextConfig;
