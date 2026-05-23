import * as React from 'react';
import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Defs, LinearGradient, Polygon, Polyline, Stop } from 'react-native-svg';

export type SparklineChartProps = {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function SparklineChartImpl({
  data,
  width = 120,
  height = 50,
  color,
}: SparklineChartProps) {
  const safeData = Array.isArray(data) ? data.filter((v) => Number.isFinite(v)) : [];

  const resolvedColor = useMemo(() => {
    if (color) return color;
    if (safeData.length < 2) return '#00E676';
    return safeData[safeData.length - 1] >= safeData[0] ? '#00E676' : '#FF5252';
  }, [color, safeData]);

  const { linePoints, areaPoints } = useMemo(() => {
    if (safeData.length < 2) return { linePoints: '', areaPoints: '' };

    const pad = 4;
    const innerW = Math.max(1, width - pad * 2);
    const innerH = Math.max(1, height - pad * 2);

    const min = Math.min(...safeData);
    const max = Math.max(...safeData);
    const range = max - min;

    const points = safeData.map((v, i) => {
      const t = safeData.length === 1 ? 0 : i / (safeData.length - 1);
      const x = pad + t * innerW;
      const yNorm = range === 0 ? 0.5 : (v - min) / range;
      const y = pad + (1 - clamp(yNorm, 0, 1)) * innerH;
      return { x, y };
    });

    const line = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

    const first = points[0];
    const last = points[points.length - 1];
    const bottomY = pad + innerH;
    const area = [
      `${first.x.toFixed(1)},${bottomY.toFixed(1)}`,
      ...points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`),
      `${last.x.toFixed(1)},${bottomY.toFixed(1)}`,
    ].join(' ');

    return { linePoints: line, areaPoints: area };
  }, [height, safeData, width]);

  const gradientId = useMemo(
    () => `spark_${resolvedColor.replace('#', '')}_${width}x${height}`,
    [height, resolvedColor, width],
  );

  if (safeData.length < 2) {
    return <View style={{ width, height }} />;
  }

  return (
    <View style={{ width, height }}>
      <Svg width={width} height={height}>
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={resolvedColor} stopOpacity="0.3" />
            <Stop offset="1" stopColor={resolvedColor} stopOpacity="0" />
          </LinearGradient>
        </Defs>

        <Polygon points={areaPoints} fill={`url(#${gradientId})`} />
        <Polyline
          points={linePoints}
          fill="none"
          stroke={resolvedColor}
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </View>
  );
}

export const SparklineChart = React.memo(SparklineChartImpl);
