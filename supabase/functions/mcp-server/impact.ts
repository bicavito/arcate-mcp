/**
 * Fermi Leverage Model — Impact scoring for initiatives.
 * FORMULA: v3.4 — keep in sync with assets/components/core/utils.js
 */

export const SEVERITY_WEIGHT: Record<string, number> = { 'High': 3, 'Medium': 2, 'Low': 1 };
export const TIER_WEIGHTS: Record<string, number> = { 'Enterprise': 100, 'Scale': 30, 'Standard': 10, 'Startup': 3, 'Free': 1 };
export const SIGNAL_TYPE_WEIGHTS: Record<string, number> = { 'deal-loss': 30, 'problem': 10, 'friction': 3, 'mention': 1 };

export interface ImpactResult {
  score: number; rawScore: number; confirmationBonus: number; uniqueAccounts: number;
  formattedScore: string; label: string; formattedArr: string; totalArr: number;
  businessValue: number; leverage: number; weightedSignals: number; volume: number;
  icpWeight: number; gated: boolean;
}

export function calculateImpact(signals: any[], customers: any[], hasRevenueScoring: boolean): ImpactResult {
  if (!signals || signals.length === 0) return { score: 0, rawScore: 0, confirmationBonus: 1, uniqueAccounts: 0, formattedScore: '0', label: 'Negligible', formattedArr: '$0', totalArr: 0, businessValue: 0, leverage: 0, weightedSignals: 0, volume: 0, icpWeight: 1, gated: !hasRevenueScoring };
  let totalArr = 0;
  const uniqueCustomers = new Set<string>();
  let maxIcpWeight = 0;
  signals.forEach((s: any) => { if (s.account_id) uniqueCustomers.add(s.account_id); });
  uniqueCustomers.forEach(custId => {
    const customer = customers.find((c: any) => c.id === custId);
    if (customer) { totalArr += (customer.arr || 0); const weight = TIER_WEIGHTS[customer.tier] || 10; if (weight > maxIcpWeight) maxIcpWeight = weight; }
  });
  if (maxIcpWeight === 0) maxIcpWeight = 1;
  const arrLog = totalArr > 0 ? Math.log10(totalArr + 1) : 0;
  const businessValue = arrLog * maxIcpWeight;
  let weightedSignalSum = 0;
  signals.forEach((s: any) => { const type = s.type?.toLowerCase() || ''; let weight = SIGNAL_TYPE_WEIGHTS['mention']; for (const [key, w] of Object.entries(SIGNAL_TYPE_WEIGHTS)) { if (type.includes(key)) { weight = w; break; } } weightedSignalSum += Math.sqrt(weight); });
  const K = 5; const volume = signals.length;
  const signalLeverage = weightedSignalSum / Math.sqrt(volume + K);
  const rawScore = businessValue * signalLeverage;
  const uniqueAccountCount = uniqueCustomers.size;
  const confirmationBonus = Math.min(2.50, 1.0 + 0.2 * Math.sqrt(Math.max(0, uniqueAccountCount - 1)));
  let simpleTotalSeverity = 0;
  signals.forEach((s: any) => { simpleTotalSeverity += SEVERITY_WEIGHT[s.severity] || 1; });
  const simpleAvg = simpleTotalSeverity / Math.max(1, signals.length);
  const simpleScore = Math.round((simpleAvg / 3) * 100);
  let finalScore: number, label: string;
  if (hasRevenueScoring) {
    finalScore = Math.round(rawScore * confirmationBonus);
    if (finalScore >= 10000) label = 'High Leverage'; else if (finalScore >= 1000) label = 'Medium Leverage'; else if (finalScore >= 100) label = 'Low Confidence'; else label = 'Negligible';
    const isHighEvidence = volume >= 30 && uniqueAccountCount >= 10;
    if (totalArr > 100000 && signalLeverage < 15.0 && !isHighEvidence) { label = 'High Risk'; finalScore = Math.round(finalScore * 0.4); }
  } else {
    finalScore = simpleScore;
    if (simpleAvg >= 2.5) label = 'High Leverage'; else if (simpleAvg >= 1.5) label = 'Medium Leverage'; else label = 'Low Confidence';
  }
  const formatScore = (s: number) => { if (!s || s <= 0) return '0'; if (s >= 10000) return `${Math.round(s / 1000)}K`; if (s >= 1000) return `${(s / 1000).toFixed(1)}K`; return String(Math.round(s)); };
  return { score: finalScore, rawScore: Math.round(rawScore), confirmationBonus: parseFloat(confirmationBonus.toFixed(3)), uniqueAccounts: uniqueAccountCount, formattedScore: formatScore(finalScore), label, formattedArr: `$${totalArr.toLocaleString('en-US')}`, totalArr, businessValue: parseFloat(businessValue.toFixed(2)), leverage: parseFloat(signalLeverage.toFixed(4)), weightedSignals: parseFloat(weightedSignalSum.toFixed(4)), volume, icpWeight: maxIcpWeight, gated: !hasRevenueScoring };
}
