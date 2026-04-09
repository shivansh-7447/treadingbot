import json
import math
import sys


def clamp(value, min_value, max_value):
    return max(min_value, min(max_value, value))


def sigmoid(value):
    return 1 / (1 + math.exp(-value))


def compute_learning_bias(payload, trend_15m, momentum_5m, momentum_1m, sentiment, whale_score):
    samples = payload.get("learningSamples", []) or []
    if not samples:
        return 0

    target_vector = [trend_15m, momentum_5m, momentum_1m, sentiment, whale_score]
    weighted_bias = 0
    total_weight = 0

    for sample in samples:
        features = sample.get("features", {}) or {}
        sample_vector = [
            float(features.get("trend15m", 0)),
            float(features.get("momentum5m", 0)),
            float(features.get("momentum1m", 0)),
            float(features.get("sentiment", 0)),
            float(features.get("whaleScore", 0)),
        ]
        distance = math.sqrt(
            sum((target_value - sample_value) ** 2 for target_value, sample_value in zip(target_vector, sample_vector))
        )
        similarity_weight = 1 / (1 + distance * 10)
        pnl_pct = float(sample.get("pnlPct", 0))
        normalized_outcome = clamp(pnl_pct / 3.0, -1, 1)
        outcome_direction = 1 if sample.get("win") else -1
        confidence_weight = max(0.35, float(features.get("confidence", 0.5)))
        weighted_bias += similarity_weight * ((normalized_outcome * 0.7) + (outcome_direction * 0.3)) * confidence_weight
        total_weight += similarity_weight

    if not total_weight:
        return 0

    return clamp(weighted_bias / total_weight, -1.2, 1.2)


def build_prediction(payload):
    trend_15m = float(payload.get("trend15m", 0))
    momentum_5m = float(payload.get("momentum5m", 0))
    momentum_1m = float(payload.get("momentum1m", 0))
    sentiment = float(payload.get("sentiment", 0))
    whale_score = float(payload.get("whaleScore", 0))
    learning_bias = compute_learning_bias(
        payload,
        trend_15m,
        momentum_5m,
        momentum_1m,
        sentiment,
        whale_score,
    )

    raw_score = (
        trend_15m * 5.5
        + momentum_5m * 4.0
        + momentum_1m * 2.5
        + sentiment * 1.5
        + whale_score * 0.8
        + learning_bias
    )

    probability_up = sigmoid(raw_score)
    confidence = abs(probability_up - 0.5) * 2
    direction = "buy" if probability_up >= 0.55 else "hold"
    if probability_up <= 0.42:
        direction = "avoid"

    expected_move_pct = clamp(raw_score * 0.8, -0.05, 0.05)

    return {
        "direction": direction,
        "probabilityUp": round(probability_up, 4),
        "confidence": round(confidence, 4),
        "expectedMovePct": round(expected_move_pct, 4),
        "learningBias": round(learning_bias, 4),
    }


def main():
    if len(sys.argv) > 1:
        payload = json.loads(sys.argv[1])
    else:
        payload = json.loads(sys.stdin.read() or "{}")

    prediction = build_prediction(payload)
    print(json.dumps(prediction))


if __name__ == "__main__":
    main()
