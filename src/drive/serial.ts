/**
 * Runs jobs strictly one after another, in the order they were asked for. A job that fails does not stop the
 * ones queued behind it.
 *
 * Drive sync used to run every job the moment it was asked for: the minute-by-minute check, a push after an edit,
 * the Sync now button and the focus check could all be in flight together. They share small lists in storage (which
 * picture was last sent, which Drive file belongs to what), so two overlapping jobs could overwrite each other's
 * notes, or fetch the same picture and write the older copy last, which looked like a thumbnail flickering back
 * to its previous picture.
 */
export function createSerialRunner(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  };
}
