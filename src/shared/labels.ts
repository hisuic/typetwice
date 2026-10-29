import type { SiteStatus } from './protocol';

export const SITE_STATUS_LABELS: Readonly<Record<SiteStatus, string>> = {
  protected: 'Protected',
  'permission-required': 'Permission required',
  off: 'Off',
};
