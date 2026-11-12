// Signal of the statistics page: rebuilt when the data or the minute changes (never on every clock frame).

import { computed } from '@preact/signals';
import { dashboardInputs } from './dashboardState';
import { activeNow, minuteBucket } from './now';
import { buildStatsModel, type StatsModel } from './stats';

export const statsModel = computed<StatsModel>(() => {
  void minuteBucket.value;
  return buildStatsModel(dashboardInputs.value, activeNow.peek());
});
