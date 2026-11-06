// Minimal on purpose. Not yet run: Next.js could not be installed in the development sandbox (no network).
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The dev server is opened at 127.0.0.1 as well as localhost. Pages still render if this socket is down.
  allowedDevOrigins: ["127.0.0.1"],
};
export default nextConfig;
