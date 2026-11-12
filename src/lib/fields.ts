/**
 * Static knowledge about common GA4 Data API fields. Used to route friendly filters to the
 * dimension or metric filter without an API call; property metadata (custom fields) is
 * consulted as a fallback.
 */

export type FieldKind = 'dimension' | 'metric';

export const COMMON_DIMENSIONS = [
    'date', 'dateHour', 'day', 'dayOfWeek', 'dayOfWeekName', 'hour', 'isoWeek', 'isoYear', 'isoYearIsoWeek',
    'month', 'week', 'year', 'yearMonth', 'yearWeek', 'nthDay', 'nthWeek', 'nthMonth',
    'hostName', 'pagePath', 'pagePathPlusQueryString', 'pageTitle', 'pageLocation', 'pageReferrer',
    'fullPageUrl', 'landingPage', 'landingPagePlusQueryString', 'unifiedScreenName', 'unifiedPagePathScreen',
    'contentGroup', 'contentId', 'contentType',
    'sessionDefaultChannelGroup', 'sessionPrimaryChannelGroup', 'sessionSource', 'sessionMedium',
    'sessionSourceMedium', 'sessionCampaignName', 'sessionCampaignId', 'sessionManualTerm', 'sessionGoogleAdsQuery',
    'sessionSourcePlatform', 'firstUserDefaultChannelGroup', 'firstUserPrimaryChannelGroup', 'firstUserSource',
    'firstUserMedium', 'firstUserSourceMedium', 'firstUserCampaignName', 'defaultChannelGroup', 'source', 'medium',
    'sourceMedium', 'campaignName',
    'country', 'countryId', 'region', 'city', 'continent', 'subContinent', 'language', 'languageCode',
    'deviceCategory', 'deviceModel', 'mobileDeviceBranding', 'operatingSystem', 'operatingSystemWithVersion',
    'browser', 'platform', 'platformDeviceCategory', 'screenResolution',
    'eventName', 'isKeyEvent', 'newVsReturning', 'firstSessionDate', 'userAgeBracket', 'userGender',
    'linkUrl', 'linkDomain', 'outbound', 'fileExtension', 'fileName', 'percentScrolled', 'searchTerm',
    'videoTitle', 'videoProvider', 'method', 'itemName', 'itemId', 'itemCategory', 'transactionId',
    'adFormat', 'adSourceName', 'adUnitName', 'minutesAgo', 'appVersion', 'audienceName', 'streamId', 'streamName',
    'signedInWithUserId', 'cohort', 'dateRange',
] as const;

export const COMMON_METRICS = [
    'activeUsers', 'active1DayUsers', 'active7DayUsers', 'active28DayUsers', 'newUsers', 'totalUsers',
    'returningUsers', 'sessions', 'sessionsPerUser', 'engagedSessions', 'engagementRate', 'bounceRate',
    'averageSessionDuration', 'userEngagementDuration', 'screenPageViews', 'screenPageViewsPerSession',
    'screenPageViewsPerUser', 'eventCount', 'eventCountPerUser', 'eventsPerSession', 'keyEvents',
    'sessionKeyEventRate', 'userKeyEventRate', 'scrolledUsers', 'dauPerMau', 'dauPerWau', 'wauPerMau',
    'totalRevenue', 'purchaseRevenue', 'grossPurchaseRevenue', 'transactions', 'ecommercePurchases',
    'averagePurchaseRevenue', 'averageRevenuePerUser', 'totalPurchasers', 'firstTimePurchasers', 'itemsViewed',
    'itemsPurchased', 'itemRevenue', 'addToCarts', 'checkouts',
    'publisherAdClicks', 'publisherAdImpressions', 'totalAdRevenue', 'adUnitExposure',
    'organicGoogleSearchClicks', 'organicGoogleSearchImpressions', 'organicGoogleSearchClickThroughRate',
    'organicGoogleSearchAveragePosition',
    'advertiserAdClicks', 'advertiserAdCost', 'advertiserAdCostPerClick', 'advertiserAdImpressions', 'returnOnAdSpend',
    'cohortActiveUsers', 'cohortTotalUsers', 'crashAffectedUsers', 'crashFreeUsersRate', 'userStickiness',
] as const;

const DIMENSION_SET = new Set<string>(COMMON_DIMENSIONS);
const METRIC_SET = new Set<string>(COMMON_METRICS);

/** customUser:x and customItem:x are always dimensions (custom metrics are event-scoped). */
const CUSTOM_DIMENSION_PREFIX = /^(customUser|customItem):/;
/** Metric variants built from event names or custom parameters. */
const CUSTOM_METRIC_PREFIX = /^(averageCustomEvent|countCustomEvent|sumCustomEvent|sessionKeyEventRate|userKeyEventRate|keyEvents):/;

/**
 * Kind of a field from static knowledge only, or undefined if unknown.
 * `customEvent:x` is ambiguous (custom dimensions and custom metrics share that prefix),
 * so it is left to property metadata.
 */
export function staticFieldKind(name: string): FieldKind | undefined {
    if (DIMENSION_SET.has(name)) return 'dimension';
    if (METRIC_SET.has(name)) return 'metric';
    if (CUSTOM_METRIC_PREFIX.test(name)) return 'metric';
    if (CUSTOM_DIMENSION_PREFIX.test(name)) return 'dimension';
    return undefined;
}

/** Dimensions whose values are page paths or URLs, and therefore get a url_key. */
export const PAGE_DIMENSIONS = new Set([
    'pagePath', 'pagePathPlusQueryString', 'landingPage', 'landingPagePlusQueryString', 'fullPageUrl', 'pageLocation',
]);

/** Dimensions that hold a full URL (with or without protocol), so no hostName is needed for the url_key. */
export const FULL_URL_DIMENSIONS = new Set(['fullPageUrl', 'pageLocation']);

/**
 * Metrics that can be summed when rows are merged (e.g. "/blog" and "/blog/" -> one url_key).
 * User counts are NOT additive across rows (one user can appear in both), so they are summed
 * but flagged as approximate.
 */
export const ADDITIVE_METRICS = new Set([
    'sessions', 'engagedSessions', 'screenPageViews', 'eventCount', 'keyEvents', 'userEngagementDuration',
    'newUsers', 'transactions', 'ecommercePurchases', 'totalRevenue', 'purchaseRevenue', 'itemRevenue',
    'publisherAdClicks', 'publisherAdImpressions', 'totalAdRevenue', 'organicGoogleSearchClicks',
    'organicGoogleSearchImpressions', 'scrolledUsers', 'addToCarts', 'checkouts',
]);

export const APPROXIMATE_WHEN_SUMMED = new Set(['totalUsers', 'activeUsers', 'newUsers', 'returningUsers', 'scrolledUsers']);
