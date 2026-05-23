import * as React from 'react';
import { useEffect, useRef } from 'react';
import { Animated, Platform, StyleProp, ViewStyle } from 'react-native';

export type PriceFlashProps = {
  price: number | null;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};

function PriceFlashImpl({ price, children, style }: PriceFlashProps) {
  const opacity = useRef(new Animated.Value(0)).current;
  const prevPriceRef = useRef<number | null>(null);
  const flashColorRef = useRef<string>('#00E67630');

  useEffect(() => {
    const prev = prevPriceRef.current;
    prevPriceRef.current = price;
    if (price === null || !Number.isFinite(price)) return;
    if (prev === null || !Number.isFinite(prev)) return;
    if (price === prev) return;

    flashColorRef.current = price > prev ? '#00E67630' : '#FF525230';
    const useNativeDriver = Platform.OS !== 'web';

    opacity.stopAnimation();
    opacity.setValue(0);
    Animated.sequence([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 150,
        useNativeDriver,
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: 300,
        useNativeDriver,
      }),
    ]).start();
  }, [opacity, price]);

  return (
    <Animated.View style={style}>
      {children}
      <Animated.View
        pointerEvents="none"
        style={[
          {
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            backgroundColor: flashColorRef.current,
            opacity,
          },
        ]}
      />
    </Animated.View>
  );
}

export const PriceFlash = React.memo(PriceFlashImpl);
