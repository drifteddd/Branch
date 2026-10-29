// a simple in-memory rate limiter (fixed windows).
// it resets when the server restarts, which is fine for one small server.
// if branch ever runs on more than one instance, this should move to postgres or redis.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

struct Window {
    started: Instant,
    count: u32,
}

#[derive(Default)]
pub struct RateLimiter {
    hits: Mutex<HashMap<String, Window>>,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    /// counts a hit and says if it's still allowed
    pub fn check(&self, key: &str, limit: u32, per: Duration) -> bool {
        let mut hits = self.hits.lock().unwrap();
        let now = Instant::now();
        let window = hits.entry(key.to_string()).or_insert(Window { started: now, count: 0 });
        if now.duration_since(window.started) >= per {
            window.started = now;
            window.count = 0;
        }
        window.count += 1;
        window.count <= limit
    }

    /// forgets old windows so memory doesn't grow forever
    pub fn prune(&self, older_than: Duration) {
        let now = Instant::now();
        self.hits.lock().unwrap().retain(|_, w| now.duration_since(w.started) < older_than);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_after_the_limit() {
        let limiter = RateLimiter::new();
        for _ in 0..3 {
            assert!(limiter.check("a", 3, Duration::from_secs(60)));
        }
        assert!(!limiter.check("a", 3, Duration::from_secs(60)));
        assert!(limiter.check("b", 3, Duration::from_secs(60)));
    }
}
