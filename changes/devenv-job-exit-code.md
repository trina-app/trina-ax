- A background job that finished by itself is no longer reported as "Trina couldn't finish the job". When a person's
  last running job ended, the dev environment could treat the end of the job as a change of their folder access and
  throw its result away; the job now keeps its own result. A job whose result truly cannot be read now says it ended
  and that Trina can't tell whether it worked, instead of calling it a failure.
