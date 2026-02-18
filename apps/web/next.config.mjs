/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  webpack: (config) => {
    config.resolve.alias['pino-pretty'] = false;
    config.resolve.alias['@react-native-async-storage/async-storage'] = false;
    return config;
  }
};

export default nextConfig;
