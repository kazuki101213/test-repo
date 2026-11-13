export interface ListingPhotoAnalysis {
  roles: Record<string, string>;
  accessories: string[];
}

const recorderRoles = {
  amazon: ['frontLeft', 'frontRight', 'rearLeft', 'rearRight', 'remoteBack'],
  mercari: ['frontLeft', 'frontRight', 'rearLeft', 'rearRight', 'remoteFront', 'remoteBack', 'remoteBattery'],
  yahoo: ['frontLeft', 'frontRight', 'front', 'rearLeft', 'rearRight', 'rear', 'bottom', 'remoteFront', 'remoteBack', 'remoteBattery'],
} as const;

export function listingPhotoOrder(
  ids: string[], analysis: ListingPhotoAnalysis, channel: keyof typeof recorderRoles, recorder: boolean,
) {
  const roles = recorder ? ['overview', ...recorderRoles[channel]] : ['overview'];
  const matched = roles.map(role => analysis.roles[role]).filter((id):id is string=>id!==undefined&&ids.includes(id));
  const remaining = channel === 'amazon' && recorder && matched.length ? [] : ids;
  return [...new Set([...matched, ...remaining])].slice(0, channel === 'amazon' ? 6 : 10);
}
