import React, { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { todayLocalIso, yesterdayLocalIso } from '@/utils/localDate';

export interface DatePickerInputProps {
  value: string; // ISO 'YYYY-MM-DD' for date mode or 'YYYY-MM' for month mode
  onChange: (value: string) => void;
  label?: string;
  testID?: string;
  mode?: 'date' | 'month';
  allowClear?: boolean;
  placeholder?: string;
}

const MONTH_NAMES = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
];

const MONTH_SHORT = [
  'Jan',
  'Fev',
  'Mar',
  'Abr',
  'Mai',
  'Jun',
  'Jul',
  'Ago',
  'Set',
  'Out',
  'Nov',
  'Dez',
];

const WEEKDAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

function formatIsoToFriendly(
  value: string,
  mode: 'date' | 'month' = 'date',
  placeholder?: string,
): string {
  if (!value) {
    return placeholder || (mode === 'month' ? 'Selecione o mês' : 'Selecione a data');
  }

  // Month mode (YYYY-MM)
  if (mode === 'month' || /^\d{4}-\d{2}$/.test(value)) {
    const [yearStr, monthStr] = value.split('-');
    const monthIdx = parseInt(monthStr, 10) - 1;
    const monthName = MONTH_NAMES[monthIdx] ?? monthStr;
    return `${monthName} de ${yearStr}`;
  }

  // Date mode (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [yearStr, monthStr, dayStr] = value.split('-');
    const monthIdx = parseInt(monthStr, 10) - 1;
    const monthName = MONTH_NAMES[monthIdx] ?? monthStr;
    const day = parseInt(dayStr, 10);
    return `${day} de ${monthName} de ${yearStr}`;
  }

  return value;
}

export function DatePickerInput({
  value,
  onChange,
  label = 'Data',
  testID = 'date-picker-input',
  mode = 'date',
  allowClear = false,
  placeholder,
}: DatePickerInputProps) {
  const [modalVisible, setModalVisible] = useState(false);

  // Initialize view year & month from current value or today
  const parsed = useMemo(() => {
    if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [y, m, d] = value.split('-').map(Number);
      return { year: y, month: m, day: d };
    }
    if (value && /^\d{4}-\d{2}$/.test(value)) {
      const [y, m] = value.split('-').map(Number);
      return { year: y, month: m, day: 1 };
    }
    const now = new Date();
    return {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
    };
  }, [value]);

  const [viewYear, setViewYear] = useState(parsed.year);
  const [viewMonth, setViewMonth] = useState(parsed.month);

  const today = useMemo(() => new Date(), []);
  const todayIso = useMemo(() => todayLocalIso(today), [today]);
  const currentMonthIso = useMemo(() => {
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  }, [today]);
  const nextMonthIso = useMemo(() => {
    const d = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }, [today]);

  const yesterdayIso = useMemo(() => yesterdayLocalIso(today), [today]);

  const openCalendar = () => {
    setViewYear(parsed.year);
    setViewMonth(parsed.month);
    setModalVisible(true);
  };

  const handlePrevYear = () => {
    setViewYear((y) => y - 1);
  };

  const handleNextYear = () => {
    setViewYear((y) => y + 1);
  };

  const handlePrevMonth = () => {
    if (viewMonth === 1) {
      setViewYear((y) => y - 1);
      setViewMonth(12);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const handleNextMonth = () => {
    if (viewMonth === 12) {
      setViewYear((y) => y + 1);
      setViewMonth(1);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  const selectDate = (day: number) => {
    const yStr = String(viewYear);
    const mStr = String(viewMonth).padStart(2, '0');
    const dStr = String(day).padStart(2, '0');
    const iso = `${yStr}-${mStr}-${dStr}`;
    onChange(iso);
    setModalVisible(false);
  };

  const selectMonth = (monthIndex: number) => {
    const yStr = String(viewYear);
    const mStr = String(monthIndex + 1).padStart(2, '0');
    onChange(`${yStr}-${mStr}`);
    setModalVisible(false);
  };

  const selectIsoDirectly = (iso: string) => {
    onChange(iso);
    setModalVisible(false);
  };

  const handleClear = () => {
    onChange('');
    setModalVisible(false);
  };

  // Calendar matrix calculations (date mode)
  const daysInMonth = useMemo(() => {
    return new Date(viewYear, viewMonth, 0).getDate();
  }, [viewYear, viewMonth]);

  const firstDayOfWeek = useMemo(() => {
    return new Date(viewYear, viewMonth - 1, 1).getDay();
  }, [viewYear, viewMonth]);

  const isToday = mode === 'date' && value === todayIso;
  const isYesterday = mode === 'date' && value === yesterdayIso;
  const isThisMonth = mode === 'month' && value === currentMonthIso;

  return (
    <View style={styles.container}>
      {label ? <Text style={styles.label}>{label}</Text> : null}

      <Pressable
        testID={testID}
        style={styles.triggerButton}
        onPress={openCalendar}
      >
        <View style={styles.triggerLeft}>
          <Text style={styles.calendarIcon}>📅</Text>
          <View style={styles.triggerTextContainer}>
            <Text style={styles.dateText} numberOfLines={1} ellipsizeMode="tail">
              {formatIsoToFriendly(value, mode, placeholder)}
            </Text>
            {isToday ? (
              <Text style={styles.subTag}>Hoje</Text>
            ) : isYesterday ? (
              <Text style={styles.subTag}>Ontem</Text>
            ) : isThisMonth ? (
              <Text style={styles.subTag}>Mês Atual</Text>
            ) : null}
          </View>
        </View>
        <Text style={styles.changeActionText}>Alterar</Text>
      </Pressable>

      <Modal
        visible={modalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setModalVisible(false)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setModalVisible(false)}
        >
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            {mode === 'month' ? (
              /* ================= MONTH PICKER ================= */
              <>
                {/* Quick Chips Header */}
                <View style={styles.quickChipsRow}>
                  <Pressable
                    style={[
                      styles.quickChip,
                      value === currentMonthIso && styles.quickChipActive,
                    ]}
                    onPress={() => selectIsoDirectly(currentMonthIso)}
                  >
                    <Text
                      style={[
                        styles.quickChipText,
                        value === currentMonthIso && styles.quickChipTextActive,
                      ]}
                    >
                      Este Mês
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.quickChip,
                      value === nextMonthIso && styles.quickChipActive,
                    ]}
                    onPress={() => selectIsoDirectly(nextMonthIso)}
                  >
                    <Text
                      style={[
                        styles.quickChipText,
                        value === nextMonthIso && styles.quickChipTextActive,
                      ]}
                    >
                      Próximo Mês
                    </Text>
                  </Pressable>
                  {allowClear && value ? (
                    <Pressable
                      style={[styles.quickChip, styles.clearChip]}
                      onPress={handleClear}
                    >
                      <Text style={styles.clearChipText}>Limpar</Text>
                    </Pressable>
                  ) : null}
                </View>

                {/* Year Navigation Header */}
                <View style={styles.monthNavRow}>
                  <Pressable
                    style={styles.navButton}
                    onPress={handlePrevYear}
                    hitSlop={12}
                  >
                    <Text style={styles.navButtonText}>‹</Text>
                  </Pressable>
                  <Text style={styles.monthTitle}>{viewYear}</Text>
                  <Pressable
                    style={styles.navButton}
                    onPress={handleNextYear}
                    hitSlop={12}
                  >
                    <Text style={styles.navButtonText}>›</Text>
                  </Pressable>
                </View>

                {/* Months Grid (4x3) */}
                <View style={styles.monthGrid}>
                  {MONTH_NAMES.map((name, idx) => {
                    const monthIso = `${viewYear}-${String(idx + 1).padStart(2, '0')}`;
                    const isSelected = value === monthIso;
                    const isCurrent = monthIso === currentMonthIso;

                    return (
                      <Pressable
                        key={name}
                        style={[
                          styles.monthCell,
                          isSelected && styles.monthCellSelected,
                          isCurrent && !isSelected && styles.monthCellCurrent,
                        ]}
                        onPress={() => selectMonth(idx)}
                      >
                        <Text
                          style={[
                            styles.monthCellText,
                            isSelected && styles.monthCellTextSelected,
                            isCurrent && !isSelected && styles.monthCellTextCurrent,
                          ]}
                        >
                          {MONTH_SHORT[idx]}
                        </Text>
                        <Text
                          style={[
                            styles.monthCellSub,
                            isSelected && styles.monthCellSubSelected,
                          ]}
                          numberOfLines={1}
                        >
                          {name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                {allowClear ? (
                  <Pressable style={styles.clearButton} onPress={handleClear}>
                    <Text style={styles.clearButtonText}>
                      Deixar em aberto (Indeterminado / Sem data final)
                    </Text>
                  </Pressable>
                ) : null}
              </>
            ) : (
              /* ================= DATE PICKER ================= */
              <>
                {/* Quick Chips Header */}
                <View style={styles.quickChipsRow}>
                  <Pressable
                    style={[
                      styles.quickChip,
                      value === todayIso && styles.quickChipActive,
                    ]}
                    onPress={() => selectIsoDirectly(todayIso)}
                  >
                    <Text
                      style={[
                        styles.quickChipText,
                        value === todayIso && styles.quickChipTextActive,
                      ]}
                    >
                      Hoje
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.quickChip,
                      value === yesterdayIso && styles.quickChipActive,
                    ]}
                    onPress={() => selectIsoDirectly(yesterdayIso)}
                  >
                    <Text
                      style={[
                        styles.quickChipText,
                        value === yesterdayIso && styles.quickChipTextActive,
                      ]}
                    >
                      Ontem
                    </Text>
                  </Pressable>
                  {allowClear && value ? (
                    <Pressable
                      style={[styles.quickChip, styles.clearChip]}
                      onPress={handleClear}
                    >
                      <Text style={styles.clearChipText}>Limpar</Text>
                    </Pressable>
                  ) : null}
                </View>

                {/* Navigation Header */}
                <View style={styles.monthNavRow}>
                  <Pressable
                    style={styles.navButton}
                    onPress={handlePrevMonth}
                    hitSlop={12}
                  >
                    <Text style={styles.navButtonText}>‹</Text>
                  </Pressable>
                  <Text style={styles.monthTitle}>
                    {MONTH_NAMES[viewMonth - 1]} {viewYear}
                  </Text>
                  <Pressable
                    style={styles.navButton}
                    onPress={handleNextMonth}
                    hitSlop={12}
                  >
                    <Text style={styles.navButtonText}>›</Text>
                  </Pressable>
                </View>

                {/* Weekday Names */}
                <View style={styles.weekdaysRow}>
                  {WEEKDAY_NAMES.map((name, i) => (
                    <Text
                      key={name}
                      style={[
                        styles.weekdayText,
                        (i === 0 || i === 6) && styles.weekendText,
                      ]}
                    >
                      {name}
                    </Text>
                  ))}
                </View>

                {/* Calendar Grid */}
                <View style={styles.grid}>
                  {Array.from({ length: firstDayOfWeek }).map((_, i) => (
                    <View key={`empty-${i}`} style={styles.dayCell} />
                  ))}

                  {Array.from({ length: daysInMonth }).map((_, i) => {
                    const dayNumber = i + 1;
                    const isSelected =
                      parsed.year === viewYear &&
                      parsed.month === viewMonth &&
                      parsed.day === dayNumber;

                    const dayIso = `${viewYear}-${String(viewMonth).padStart(
                      2,
                      '0',
                    )}-${String(dayNumber).padStart(2, '0')}`;
                    const isDayToday = dayIso === todayIso;

                    return (
                      <Pressable
                        key={`day-${dayNumber}`}
                        style={[
                          styles.dayCell,
                          styles.dayButton,
                          isSelected && styles.dayButtonSelected,
                          isDayToday && !isSelected && styles.dayButtonToday,
                        ]}
                        onPress={() => selectDate(dayNumber)}
                      >
                        <Text
                          style={[
                            styles.dayText,
                            isSelected && styles.dayTextSelected,
                            isDayToday && !isSelected && styles.dayTextToday,
                          ]}
                        >
                          {dayNumber}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            )}

            {/* Cancel Button */}
            <Pressable
              style={styles.closeButton}
              onPress={() => setModalVisible(false)}
            >
              <Text style={styles.closeButtonText}>Cancelar</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 6,
    width: '100%',
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: '#CBD5E1',
    marginBottom: 6,
  },
  triggerButton: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  triggerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
    marginRight: 8,
  },
  triggerTextContainer: {
    flex: 1,
  },
  calendarIcon: {
    fontSize: 18,
  },
  dateText: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '600',
  },
  subTag: {
    color: '#818CF8',
    fontSize: 11,
    fontWeight: '500',
    marginTop: 2,
  },
  changeActionText: {
    color: '#818CF8',
    fontSize: 13,
    fontWeight: '600',
    flexShrink: 0,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#1E293B',
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: '#334155',
  },
  quickChipsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 14,
    justifyContent: 'center',
    flexWrap: 'wrap',
  },
  quickChip: {
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  quickChipActive: {
    backgroundColor: '#312E81',
    borderColor: '#818CF8',
  },
  clearChip: {
    borderColor: '#DC2626',
    backgroundColor: '#450A0A',
  },
  quickChipText: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '600',
  },
  quickChipTextActive: {
    color: '#E0E7FF',
  },
  clearChipText: {
    color: '#FCA5A5',
    fontSize: 12,
    fontWeight: '600',
  },
  monthNavRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  navButton: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#334155',
    alignItems: 'center',
    justifyContent: 'center',
  },
  navButtonText: {
    color: '#F8FAFC',
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 22,
  },
  monthTitle: {
    color: '#F8FAFC',
    fontSize: 16,
    fontWeight: '700',
  },
  weekdaysRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
    paddingHorizontal: 2,
  },
  weekdayText: {
    width: '14.28%',
    textAlign: 'center',
    color: '#64748B',
    fontSize: 11,
    fontWeight: '600',
  },
  weekendText: {
    color: '#94A3B8',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 14,
  },
  dayCell: {
    width: '14.28%',
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 2,
  },
  dayButton: {
    borderRadius: 8,
  },
  dayButtonSelected: {
    backgroundColor: '#4F46E5',
  },
  dayButtonToday: {
    borderWidth: 1,
    borderColor: '#818CF8',
    backgroundColor: '#1E1B4B',
  },
  dayText: {
    color: '#CBD5E1',
    fontSize: 13,
    fontWeight: '500',
  },
  dayTextSelected: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  dayTextToday: {
    color: '#818CF8',
    fontWeight: '700',
  },
  monthGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  monthCell: {
    width: '31%',
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthCellSelected: {
    backgroundColor: '#4F46E5',
    borderColor: '#818CF8',
  },
  monthCellCurrent: {
    borderColor: '#818CF8',
    backgroundColor: '#1E1B4B',
  },
  monthCellText: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '700',
  },
  monthCellTextSelected: {
    color: '#FFFFFF',
  },
  monthCellTextCurrent: {
    color: '#818CF8',
  },
  monthCellSub: {
    color: '#64748B',
    fontSize: 10,
    marginTop: 2,
  },
  monthCellSubSelected: {
    color: '#E0E7FF',
  },
  clearButton: {
    alignItems: 'center',
    paddingVertical: 8,
    marginBottom: 10,
  },
  clearButtonText: {
    color: '#94A3B8',
    fontSize: 12,
    textDecorationLine: 'underline',
  },
  closeButton: {
    backgroundColor: '#334155',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  closeButtonText: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: '600',
  },
});
