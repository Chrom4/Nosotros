import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, {
  Circle,
  Defs,
  G,
  Line,
  LinearGradient,
  Path,
  Stop,
} from 'react-native-svg';
import type { MD3ContextTheme } from '@/theme';

export interface NetWorthPoint {
  competenceMonth: string;
  label: string; // e.g. "Jun", "Jul", "Ago"
  netWorthCents: number;
}

export interface NetWorthChartProps {
  data: NetWorthPoint[];
  width?: number;
  height?: number;
  theme?: MD3ContextTheme;
}

export const NetWorthChart: React.FC<NetWorthChartProps> = ({
  data,
  width = 330,
  height = 150,
  theme,
}) => {
  const primaryColor = theme?.primary ?? '#6366F1';
  const textColor = theme?.textSecondary ?? '#94A3B8';

  if (!data || data.length === 0) {
    return (
      <View
        testID="net-worth-chart"
        style={[styles.emptyContainer, { height }]}
      >
        <Text style={[styles.emptyText, { color: textColor }]}>
          Sem dados históricos para o gráfico
        </Text>
      </View>
    );
  }

  const padding = { top: 16, bottom: 26, left: 16, right: 16 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const values = data.map((d) => d.netWorthCents);
  let minVal = Math.min(...values);
  let maxVal = Math.max(...values);

  if (minVal === maxVal) {
    const delta = Math.abs(minVal) > 0 ? Math.round(Math.abs(minVal) * 0.1) : 10000;
    minVal -= delta;
    maxVal += delta;
  } else {
    // Add 10% breathing room
    const range = maxVal - minVal;
    minVal -= Math.round(range * 0.05);
    maxVal += Math.round(range * 0.05);
  }

  const range = maxVal - minVal;

  const points = data.map((d, index) => {
    const x =
      data.length === 1
        ? padding.left + plotWidth / 2
        : padding.left + (index / (data.length - 1)) * plotWidth;
    const y = padding.top + plotHeight - ((d.netWorthCents - minVal) / range) * plotHeight;
    return { x, y, point: d };
  });

  // Construct line path
  const linePath = points.reduce((acc, curr, index) => {
    return index === 0 ? `M ${curr.x} ${curr.y}` : `${acc} L ${curr.x} ${curr.y}`;
  }, '');

  // Construct area path
  const baselineY = padding.top + plotHeight;
  const areaPath =
    points.length > 0
      ? `${linePath} L ${points[points.length - 1].x} ${baselineY} L ${points[0].x} ${baselineY} Z`
      : '';

  // Calculate zero line if it crosses zero
  const hasZeroCrossing = minVal < 0 && maxVal > 0;
  const zeroY = hasZeroCrossing
    ? padding.top + plotHeight - ((0 - minVal) / range) * plotHeight
    : null;

  return (
    <View testID="net-worth-chart" style={[styles.container, { width, height }]}>
      <Svg width={width} height={height}>
        <Defs>
          <LinearGradient id="netWorthGradient" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor={primaryColor} stopOpacity="0.35" />
            <Stop offset="100%" stopColor={primaryColor} stopOpacity="0.0" />
          </LinearGradient>
        </Defs>

        {/* Zero baseline if crosses 0 */}
        {zeroY !== null ? (
          <Line
            x1={padding.left}
            y1={zeroY}
            x2={width - padding.right}
            y2={zeroY}
            stroke="#475569"
            strokeDasharray="4,4"
            strokeWidth={1}
          />
        ) : null}

        {/* Area fill */}
        {areaPath ? <Path d={areaPath} fill="url(#netWorthGradient)" /> : null}

        {/* Polyline */}
        {linePath ? (
          <Path
            d={linePath}
            fill="none"
            stroke={primaryColor}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}

        {/* Data nodes */}
        <G>
          {points.map((pt, idx) => (
            <Circle
              key={pt.point.competenceMonth}
              cx={pt.x}
              cy={pt.y}
              r={idx === points.length - 1 ? 4.5 : 3}
              fill={idx === points.length - 1 ? '#FFFFFF' : primaryColor}
              stroke={primaryColor}
              strokeWidth={idx === points.length - 1 ? 2 : 1}
            />
          ))}
        </G>
      </Svg>

      {/* X-axis labels */}
      <View style={[styles.labelsRow, { paddingHorizontal: padding.left }]}>
        {data.map((d) => (
          <Text
            key={d.competenceMonth}
            style={[styles.axisLabel, { color: textColor }]}
          >
            {d.label}
          </Text>
        ))}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignSelf: 'center',
    position: 'relative',
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    fontSize: 13,
  },
  labelsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    position: 'absolute',
    bottom: 4,
    left: 0,
    right: 0,
  },
  axisLabel: {
    fontSize: 11,
    fontWeight: '500',
  },
});
