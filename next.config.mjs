/** @type {import('next').NextConfig} */
const nextConfig = {
	typescript: {
		ignoreBuildErrors: true,
	},
	images: {
		unoptimized: true,
	},
	async rewrites() {
		return [
			// Proxy API requests to Go backend
			{
				source: "/api/:path*",
				destination: "http://localhost:3001/api/:path*",
			},
			// Proxy auth requests to Go backend
			{
				source: "/auth/:path*",
				destination: "http://localhost:3001/auth/:path*",
			},
			// Health check
			{
				source: "/health",
				destination: "http://localhost:3001/health",
			},
		];
	},
};

export default nextConfig;
