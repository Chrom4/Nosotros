import React from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface BottomSheetModalProps {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
  testID?: string;
  closeTestID?: string;
  /** Max height of the sheet (default 92% of screen). */
  maxHeight?: number | `${number}%`;
  sheetStyle?: StyleProp<ViewStyle>;
  showCloseButton?: boolean;
}

/**
 * Shared bottom sheet: transparent Modal + absolute backdrop Pressable
 * (dismiss on outside tap / Android back) + KeyboardAvoidingView + safe area.
 */
export function BottomSheetModal({
  visible,
  onClose,
  children,
  title,
  testID,
  closeTestID,
  maxHeight = '92%',
  sheetStyle,
  showCloseButton = true,
}: BottomSheetModalProps) {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.root} testID={testID}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Fechar"
          testID={testID ? `${testID}-backdrop` : undefined}
        />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.keyboard}
          pointerEvents="box-none"
        >
          <View
            style={[
              styles.sheet,
              {
                maxHeight,
                paddingBottom: Math.max(insets.bottom, 16),
              },
              sheetStyle,
            ]}
          >
            {title || showCloseButton ? (
              <View style={styles.headerRow}>
                <Text style={styles.title} numberOfLines={2}>
                  {title ?? ''}
                </Text>
                {showCloseButton ? (
                  <Pressable
                    testID={
                      closeTestID ??
                      (testID ? `${testID}-close` : 'bottom-sheet-close')
                    }
                    onPress={onClose}
                    style={styles.closeBtn}
                    hitSlop={8}
                  >
                    <Text style={styles.closeBtnText}>Fechar</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            {children}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(2, 6, 23, 0.72)',
  },
  keyboard: {
    width: '100%',
  },
  sheet: {
    backgroundColor: '#1E293B',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
    borderColor: '#334155',
    paddingHorizontal: 16,
    paddingTop: 14,
    width: '100%',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
    gap: 12,
  },
  title: {
    flex: 1,
    color: '#F8FAFC',
    fontSize: 17,
    fontWeight: '700',
  },
  closeBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  closeBtnText: {
    color: '#818CF8',
    fontSize: 14,
    fontWeight: '600',
  },
});
