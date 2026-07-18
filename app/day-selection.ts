import type { IsoDate, WeekId } from "../lib/household-contract.ts";
import { weekContainsDate } from "../lib/household-domain.ts";

export function resolveDayDate(
  weekStartDate: WeekId | null,
  today: IsoDate,
  selectedDayDate: IsoDate | null,
): IsoDate {
  if (!weekStartDate) return today;
  if (selectedDayDate && weekContainsDate(weekStartDate, selectedDayDate)) return selectedDayDate;
  return weekContainsDate(weekStartDate, today) ? today : weekStartDate;
}
