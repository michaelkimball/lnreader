// Minimal mock for expo-file-system used in db (Node.js) test environment.
// The real module requires expo-modules-core which accesses Platform.OS at import time.

const mockFileInstance = {
  exists: false,
  uri: '/mock/path/file.ext',
  text: jest.fn().mockResolvedValue(''),
  delete: jest.fn(),
};

const File = jest.fn().mockImplementation(uri => ({
  ...mockFileInstance,
  uri,
}));

const Directory = jest.fn().mockImplementation(uri => ({
  uri,
  exists: false,
  delete: jest.fn(),
  list: jest.fn().mockResolvedValue([]),
}));

const Paths = {
  cache: '/mock/cache',
  document: '/mock/document',
  temporary: '/mock/tmp',
};

module.exports = { File, Directory, Paths };
