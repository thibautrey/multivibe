const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// EX_NOHOST (68) signals an unavailable Apple ticket service. Keep permanent
// ticket failures fatal and never repeat the notarization submission here.
export async function runMacStapler(action, file, run, wait = pause) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run("xcrun", ["stapler", action, file]);
    } catch (error) {
      if (error.code !== 68 || attempt >= 3) throw error;
      console.warn(`Apple ticket lookup unavailable; retrying stapler ${action} (attempt ${attempt + 1}/3)`);
      await wait(attempt * 5000);
    }
  }
}
