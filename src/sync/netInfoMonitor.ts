import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import type { NetworkMonitor } from './networkMonitor';

function isReachable(state: NetInfoState): boolean {
  // `isInternetReachable` is null while unknown: trust `isConnected` in that case.
  return Boolean(state.isConnected) && state.isInternetReachable !== false;
}

/**
 * Production `NetworkMonitor` backed by `@react-native-community/netinfo`.
 */
export function createNetInfoMonitor(): NetworkMonitor {
  return {
    async isOnline() {
      return isReachable(await NetInfo.fetch());
    },
    subscribe(listener) {
      return NetInfo.addEventListener((state) => listener(isReachable(state)));
    },
  };
}
