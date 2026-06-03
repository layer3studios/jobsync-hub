// FILE: src/Db/analytics/leaderboardShape.js
// Pipeline + per-company shaping used by hiringLeaderboard.js.
// Kept separate so the main file stays focused on caching + entry point.

export function buildPipeline(now, sevenDaysAgo, fourteenDaysAgo, thirtyDaysAgo) {
  return [
    { $match: { Status: 'active' } },
    {
      $addFields: {
        // Recency signal: real PostedDate when we have it, otherwise nothing.
        // We deliberately do NOT fall back to createdAt for "new this week" —
        // createdAt is when JobMesh first saw the job, which on a fresh deploy
        // makes every job look new.
        _postedDate: '$PostedDate',
        // For age calculations, fall back to createdAt so jobs without
        // PostedDate (mostly older Greenhouse jobs) still get an avg age.
        _ageAnchor: { $ifNull: ['$PostedDate', '$createdAt'] },
      },
    },
    {
      $group: {
        _id: { $toLower: '$Company' },
        displayName: { $first: '$Company' },
        totalActiveRoles: { $sum: 1 },
        newThisWeek: {
          $sum: {
            $cond: [
              { $and: [
                { $ne: ['$_postedDate', null] },
                { $gte: ['$_postedDate', sevenDaysAgo] },
              ]},
              1, 0,
            ],
          },
        },
        newLastWeek: {
          $sum: {
            $cond: [
              { $and: [
                { $ne: ['$_postedDate', null] },
                { $gte: ['$_postedDate', fourteenDaysAgo] },
                { $lt: ['$_postedDate', sevenDaysAgo] },
              ]},
              1, 0,
            ],
          },
        },
        // Jobs where we lack a real PostedDate (mostly Greenhouse).
        unknownDateCount: {
          $sum: { $cond: [{ $eq: ['$_postedDate', null] }, 1, 0] },
        },
        staleRoles: {
          $sum: { $cond: [
            { $and: [
              { $ne: ['$_ageAnchor', null] },
              { $lt: ['$_ageAnchor', thirtyDaysAgo] },
            ]},
            1, 0,
          ]},
        },
        locations: { $addToSet: '$Location' },
        roleCategories: { $addToSet: '$autoTags.roleCategory' },
        avgAgeDays: {
          $avg: {
            $cond: [
              { $ne: ['$_ageAnchor', null] },
              { $divide: [{ $subtract: [now, '$_ageAnchor'] }, 86400000] },
              null,
            ],
          },
        },
        mostRecentJobDate: { $max: '$_postedDate' },
      },
    },
    { $match: { totalActiveRoles: { $gte: 2 } } },
    { $sort: { newThisWeek: -1, totalActiveRoles: -1 } },
  ];
}

export function formatCompany(raw, index) {
  // Stale ratio uses jobs with known dates as the denominator — otherwise
  // companies with all-null Greenhouse dates would always show 0% stale.
  const datedJobs = raw.totalActiveRoles - (raw.unknownDateCount || 0);
  const staleRatio = datedJobs > 0
    ? Math.round((raw.staleRoles / datedJobs) * 100)
    : 0;
  const delta = raw.newThisWeek - raw.newLastWeek;
  const trend = delta > 0 ? 'up' : delta < 0 ? 'down' : 'stable';

  let hiringSignal = 'steady';
  if (raw.newThisWeek >= 5) hiringSignal = 'hot';
  else if (raw.newThisWeek >= 1) hiringSignal = 'active';
  else if (staleRatio > 50) hiringSignal = 'stale';

  const cities = [...new Set(
    (raw.locations || [])
      .filter(l => l && l !== 'N/A')
      .map(l => l.split(',')[0].trim()),
  )].slice(0, 3);

  const topRoles = (raw.roleCategories || [])
    .filter(r => r && r !== 'Other' && r !== 'null')
    .slice(0, 4);

  return {
    rank: index + 1,
    company: raw.displayName || raw._id,

    // Counts — both names for back-compat
    totalActiveRoles: raw.totalActiveRoles,
    totalRoles: raw.totalActiveRoles,
    newThisWeek: raw.newThisWeek,
    newLastWeek: raw.newLastWeek,
    delta,
    weekOverWeek: delta,
    trend,

    // How many of this company's roles we have no PostedDate for
    unknownDateCount: raw.unknownDateCount || 0,

    hiringSignal,
    signal: hiringSignal,

    staleRoles: raw.staleRoles,
    staleRatio,
    stalePercent: staleRatio,

    avgAgeDays: raw.avgAgeDays !== null ? Math.round(raw.avgAgeDays) : null,
    cities,
    topRoles,
    mostRecentJobDate: raw.mostRecentJobDate,
  };
}
