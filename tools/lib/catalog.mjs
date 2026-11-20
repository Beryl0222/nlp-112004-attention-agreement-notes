// 本地活动目录：只认用户自定的应用、别称和用途；未登记的词不臆断。

export function buildCatalog(bundle) {
  const activities = bundle.activities;
  const byId = new Map(activities.map(a => [a.id, a]));
  const wordToActivity = new Map();
  for (const a of activities) {
    wordToActivity.set(a.application, a.id);
    for (const alias of a.aliases) wordToActivity.set(alias, a.id);
  }

  // 用途由哪个池计费，严格两步，只依据用户目录：
  //  1) 同名：用途文字与某池标签相同（如“随手看”）才直接计费；
  //  2) 显式本地别名：用户活动目录里“短休”池的成员用途以“放松”表达，登记 放松→短休。
  // 等快递/联系家人/作业/查资料与任何池标签不同名，不自动计费，避免把正当用途误扣成随手看。
  const pools = bundle.pools;
  const purposeToPool = new Map();
  const poolById = new Map(pools.map(p => [p.id, p]));
  for (const pool of pools) purposeToPool.set(pool.label, pool.id);

  const PURPOSE_POOL_ALIASES = { 放松: '短休' };
  for (const [purpose, label] of Object.entries(PURPOSE_POOL_ALIASES)) {
    const pool = pools.find(p => p.label === label);
    if (pool) purposeToPool.set(purpose, pool.id);
  }

  function matchActivity(text) {
    const hits = new Set();
    for (const [word, id] of wordToActivity) {
      if (text.includes(word)) hits.add(id);
    }
    return [...hits];
  }

  function poolOfPurpose(purpose) {
    return purposeToPool.get(purpose) ?? null;
  }

  function poolsCharging(activityId) {
    return pools.filter(p => p.memberActivity.includes(activityId)).map(p => p.id);
  }

  return { activities, pools, byId, poolById, matchActivity, poolOfPurpose, poolsCharging };
}

export function activityName(catalog, id) {
  return catalog.byId.get(id)?.application ?? id;
}

export function describeActivity(catalog, id) {
  const a = catalog.byId.get(id);
  if (!a) return id;
  return `${a.application}（别称：${a.aliases.join('、') || '无'}）`;
}
