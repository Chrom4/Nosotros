import React, { useCallback } from 'react';
import {
  type StyleProp,
  StyleSheet,
  TextInput,
  type TextInputProps,
  type TextStyle,
} from 'react-native';

export interface CurrencyInputProps extends Omit<TextInputProps, 'value' | 'onChangeText'> {
  valueCents: number;
  onChangeCents: (cents: number) => void;
  style?: StyleProp<TextStyle>;
  placeholder?: string;
  testID?: string;
  autoFocus?: boolean;
}

export function formatCentsToCurrencyString(cents: number): string {
  const safeCents = Math.max(0, Math.floor(cents || 0));
  const reais = Math.floor(safeCents / 100);
  const centavos = String(safeCents % 100).padStart(2, '0');
  const formattedReais = reais.toLocaleString('pt-BR');
  return `R$ ${formattedReais},${centavos}`;
}

export function CurrencyInput({
  valueCents,
  onChangeCents,
  style,
  placeholder = 'R$ 0,00',
  testID,
  autoFocus,
  ...rest
}: CurrencyInputProps) {
  const handleChangeText = useCallback(
    (text: string) => {
      // Remove all non-digit characters
      const cleanDigits = text.replace(/\D/g, '');
      const parsed = parseInt(cleanDigits, 10);
      const newCents = isNaN(parsed) ? 0 : parsed;
      onChangeCents(newCents);
    },
    [onChangeCents],
  );

  const displayValue =
    valueCents > 0 ? formatCentsToCurrencyString(valueCents) : '';

  return (
    <TextInput
      testID={testID}
      style={[styles.defaultInput, style]}
      value={displayValue}
      onChangeText={handleChangeText}
      placeholder={placeholder}
      placeholderTextColor="#64748B"
      keyboardType="number-pad"
      autoFocus={autoFocus}
      selectTextOnFocus={false}
      {...rest}
    />
  );
}

const styles = StyleSheet.create({
  defaultInput: {
    backgroundColor: '#0F172A',
    borderColor: '#334155',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#F8FAFC',
    fontSize: 15,
  },
});
