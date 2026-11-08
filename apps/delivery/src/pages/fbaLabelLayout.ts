export const labelPaper = {
  width: 210,
  height: 297,
  labelWidth: 66,
  labelHeight: 33.9,
  columns: 3,
  rows: 8,
} as const;
export const labelSlots = labelPaper.columns * labelPaper.rows;

export const calibrationFields = [
  {key: 'left', label: '左右', positive: '＋で右', limit: 15},
  {key: 'top', label: '上下', positive: '＋で下', limit: 15},
  {key: 'columns', label: '列の間隔', positive: '＋で広く', limit: 3},
  {key: 'rows', label: '行の間隔', positive: '＋で広く', limit: 3},
] as const;

export type LabelCalibration = Record<(typeof calibrationFields)[number]['key'], number>;
export type CalibrationInput = Record<keyof LabelCalibration, string>;
export const defaultCalibration: LabelCalibration = {left: 0, top: 0, columns: 0, rows: 0};
const calibrationKey = 'delivery:fba-label-calibration:a4-24-66x33.9';

export function calibrationInput(calibration: LabelCalibration): CalibrationInput {
  return {
    left: String(calibration.left), top: String(calibration.top),
    columns: String(calibration.columns), rows: String(calibration.rows),
  };
}

export function parseCalibration(input: CalibrationInput): LabelCalibration | null {
  const calibration = {...defaultCalibration};
  for (const {key, limit} of calibrationFields) {
    const text = input[key].trim();
    if (!/^[+-]?(?:\d+(?:\.\d)?|\.\d)$/.test(text)) return null;
    const value = Number(text);
    if (Math.abs(value) > limit) return null;
    calibration[key] = value;
  }
  return calibration;
}

export function readCalibration(): LabelCalibration {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(calibrationKey) ?? 'null');
    if (!stored || typeof stored !== 'object') return defaultCalibration;
    const calibration = {...defaultCalibration};
    for (const {key} of calibrationFields) {
      const value = (stored as Partial<LabelCalibration>)[key];
      if (typeof value !== 'number') return defaultCalibration;
      calibration[key] = value;
    }
    return parseCalibration(calibrationInput(calibration)) ?? defaultCalibration;
  } catch {
    return defaultCalibration;
  }
}

export function saveCalibration(calibration: LabelCalibration) {
  try {
    localStorage.setItem(calibrationKey, JSON.stringify(calibration));
  } catch {
    // Printing still works for the current session when storage is unavailable.
  }
}

export function labelPosition(index: number, calibration: LabelCalibration) {
  const column = Math.floor(index / labelPaper.rows);
  const row = index % labelPaper.rows;
  const left = (labelPaper.width - labelPaper.columns * labelPaper.labelWidth) / 2;
  const top = (labelPaper.height - labelPaper.rows * labelPaper.labelHeight) / 2;
  return {
    left: `${(left + calibration.left + column * (labelPaper.labelWidth + calibration.columns)).toFixed(2)}mm`,
    top: `${(top + calibration.top + row * (labelPaper.labelHeight + calibration.rows)).toFixed(2)}mm`,
    width: `${labelPaper.labelWidth}mm`,
    height: `${labelPaper.labelHeight}mm`,
  };
}
