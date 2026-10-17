// Browser stub for @react-native-async-storage/async-storage (referenced by wallet SDKs, unused in browsers).
const mockStorage = {
  getItem: () => Promise.resolve(null),
  setItem: () => Promise.resolve(),
  removeItem: () => Promise.resolve(),
  mergeItem: () => Promise.resolve(),
  clear: () => Promise.resolve(),
  getAllKeys: () => Promise.resolve([]),
  flushGetRequests: () => {},
  multiGet: () => Promise.resolve([]),
  multiSet: () => Promise.resolve(),
  multiRemove: () => Promise.resolve(),
  multiMerge: () => Promise.resolve(),
  useAsyncStorage: () => ({ getItem: () => Promise.resolve(null), setItem: () => Promise.resolve(), removeItem: () => Promise.resolve() }),
}
export default mockStorage
