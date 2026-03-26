// Learn more https://docs.expo.io/guides/customizing-metro

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */

const path = require('path');
const fs = require('fs');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const defaultConfig = getDefaultConfig(__dirname);

const map = {
  '.ico': 'image/x-icon',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};
const customConfig = {
  resolver: {
    unstable_enableSymlinks: true,
    sourceExts: [...defaultConfig.resolver.sourceExts, 'sql'],
    extraNodeModules: {
      buffer: path.resolve(__dirname, 'node_modules/.pnpm/buffer@6.0.3/node_modules/buffer'),
      'node-forge': path.resolve(__dirname, 'node_modules/.pnpm/node-forge@1.3.3/node_modules/node-forge'),
    },
  },
  server: {
    port: 8081,
    enhanceMiddleware: (metroMiddleware, metroServer) => {
      return (request, res, next) => {
        const filePath = path.join(
          __dirname,
          'android/app/src/main',
          request._parsedUrl.path || '',
        );
        const ext = path.parse(filePath).ext;
        if (fs.existsSync(filePath)) {
          try {
            const data = fs.readFileSync(filePath);
            res.setHeader('Content-type', map[ext] || 'text/plain');
            res.end(data);
          } catch (err) {
            res.statusCode = 500;
            res.end(`Error getting the file: ${err}.`);
          }
        } else {
          return metroMiddleware(request, res, next);
        }
      };
    },
  },
};
module.exports = mergeConfig(defaultConfig, customConfig);
