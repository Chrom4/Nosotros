import React from 'react';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

export type TabIconName =
  | 'dashboard'
  | 'transactions'
  | 'accounts'
  | 'cards'
  | 'invoices'
  | 'recurring'
  | 'categories'
  | 'backup'
  | 'settings';

interface TabIconProps {
  name: TabIconName;
  color?: any;
  size?: number;
}

export function TabIcon({ name, color = '#94A3B8', size = 22 }: TabIconProps) {
  const iconColor = color || '#94A3B8';
  switch (name) {
    case 'dashboard':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Rect
            x="3"
            y="3"
            width="7"
            height="7"
            rx="1.5"
            stroke={iconColor}
            strokeWidth="2"
          />
          <Rect
            x="14"
            y="3"
            width="7"
            height="7"
            rx="1.5"
            stroke={iconColor}
            strokeWidth="2"
          />
          <Rect
            x="14"
            y="14"
            width="7"
            height="7"
            rx="1.5"
            stroke={iconColor}
            strokeWidth="2"
          />
          <Rect
            x="3"
            y="14"
            width="7"
            height="7"
            rx="1.5"
            stroke={iconColor}
            strokeWidth="2"
          />
        </Svg>
      );

    case 'transactions':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path
            d="M7 16V4m0 0L3 8m4-4l4 4m6 4v12m0 0l4-4m-4 4l-4-4"
            stroke={iconColor}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      );

    case 'accounts':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path
            d="M3 21h18M3 10h18M5 10v7M9 10v7M15 10v7M19 10v7M12 3l9 7H3l9-7z"
            stroke={iconColor}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      );

    case 'cards':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Rect
            x="2"
            y="5"
            width="20"
            height="14"
            rx="2.5"
            stroke={iconColor}
            strokeWidth="2"
          />
          <Line
            x1="2"
            y1="10"
            x2="22"
            y2="10"
            stroke={iconColor}
            strokeWidth="2"
          />
        </Svg>
      );

    case 'invoices':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path
            d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1-2-1z"
            stroke={iconColor}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <Line
            x1="8"
            y1="7"
            x2="16"
            y2="7"
            stroke={iconColor}
            strokeWidth="2"
            strokeLinecap="round"
          />
          <Line
            x1="8"
            y1="11"
            x2="16"
            y2="11"
            stroke={iconColor}
            strokeWidth="2"
            strokeLinecap="round"
          />
          <Line
            x1="8"
            y1="15"
            x2="12"
            y2="15"
            stroke={iconColor}
            strokeWidth="2"
            strokeLinecap="round"
          />
        </Svg>
      );

    case 'recurring':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path
            d="M21 2v6h-6M3 12a9 9 0 0 1 15.5-6.36L21 8M3 22v-6h6M21 12a9 9 0 0 1-15.5 6.36L3 16"
            stroke={iconColor}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      );

    case 'categories':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path
            d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"
            stroke={iconColor}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <Circle cx="7" cy="7" r="1.5" fill={iconColor} />
        </Svg>
      );

    case 'backup':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path
            d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"
            stroke={iconColor}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <Path
            d="M9 12l2 2 4-4"
            stroke={iconColor}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      );

    case 'settings':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path
            d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"
            stroke={iconColor}
            strokeWidth="2"
          />
          <Path
            d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.3.6.9 1 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"
            stroke={iconColor}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      );

    default:
      return null;
  }
}
