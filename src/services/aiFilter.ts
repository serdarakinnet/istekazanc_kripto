import { ScannedCandidate } from './tradingEngine';

/**
 * AI Katmanı - N8N prompt kurallarının deterministik uygulaması
 *
 * Kurallar:
 * 1) BTCTRY ve ETHTRY kesinlikle seçme.
 * 2) R:R < 1.5 olanları seçme.
 * 3) isFlat=true veya isPump=true olanları seçme.
 * 4) intradayChg >= 3.0 olanları önceliklendir.
 * 5) MA/EMA trend güvenliği (trendOk=true) olanları önceliklendir.
 * 6) Premium öncelik: pullbackReclaim=true olanlara en üst öncelik.
 * 7) Hacim kalitesi: volMult >= 1.2 öncelik.
 * 8) En iyi olanları seç (puan hesaplamasıyla sırala).
 */
export function aiFilterCandidates(candidates: ScannedCandidate[]): ScannedCandidate[] {
  // 1. Hard Filter (Kesin eleme kuralları)
  const filtered = candidates.filter((c) => {
    // Kural 1: BTC ve ETH artık serbest (kullanıcı isteğiyle)
    
    // Kural 2: R:R < 1.5 olanları ele
    if (c.riskReward < 1.5) return false;

    // Kural 3: isFlat veya isPump olanları ele
    if (c.scoreBreakdown.flatPenalty || c.scoreBreakdown.pumpPenalty) return false;

    return true;
  });

  // 2. Scoring & Prioritization (Önceliklendirme)
  const scored = filtered.map((c) => {
    let aiScore = c.score; // Temel skordan başla

    // Kural 4: intradayChg >= 3.0 önceliği
    if (c.lastChangePercent >= 3.0) {
      aiScore += 15;
    }

    // Kural 5: Trend güvenliği
    if (c.scoreBreakdown.trendOk) {
      aiScore += 10;
    }

    // Kural 6: Premium EMA144 / Pullback Reclaim önceliği
    if (c.scoreBreakdown.pullbackReclaim) {
      aiScore += 25;
    }

    // Kural 7: Hacim kalitesi
    if (c.volMult >= 1.2) {
      aiScore += 10;
    }

    // Maksimum skoru sınırla (görsel tutarlılık için)
    return {
      ...c,
      score: Math.min(99, aiScore), // AI ile güçlendirilmiş yeni skor
    };
  });

  // 3. Sort (Skora göre azalan)
  scored.sort((a, b) => b.score - a.score);

  return scored;
}
