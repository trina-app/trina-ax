// Preload for the legacy converter comparison inside the isolated T1 container.
import { setupServerCgroups } from '../../server/src/system/cgroups'
if (setupServerCgroups({mode:'prod'}).state !== 'delegated') throw new Error('test converter delegation unavailable')
