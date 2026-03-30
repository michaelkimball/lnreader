// This file is required for Expo/React Native SQLite migrations - https://orm.drizzle.team/quick-sqlite/expo

import m0000 from './20251222152612_past_mandrill/migration.sql';
import m0001 from './20260321180828_living_master_mold/migration.sql';
import m0002 from './20260327000001_tts_element_offsets/migration.sql';

  export default {
    migrations: {
      "20251222152612_past_mandrill": m0000,
"20260321180828_living_master_mold": m0001,
"20260327000001_tts_element_offsets": m0002
}
  }
  