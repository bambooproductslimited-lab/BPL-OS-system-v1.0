// An employee's work week (employees.work_days, migration 0109): which
// weekdays are rest days. 0 = Sunday … 6 = Saturday. NULL is the usual
// Monday-to-Saturday week.
var WORK_WEEKS = ['mon_fri', 'mon_sat', 'all'];

function restWeekdays(workDays) {
  if (workDays === 'mon_fri') return [0, 6];
  if (workDays === 'all') return [];
  return [0];
}

module.exports = { WORK_WEEKS: WORK_WEEKS, restWeekdays: restWeekdays };
