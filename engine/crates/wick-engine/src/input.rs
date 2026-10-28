//! Turns macro input commands into timed OS actions.
//!
//! Every action passes the same gate: the macro must have declared the
//! matching permission, and the target window must be focused. Presses that
//! are still held when a macro ends are released.

use std::collections::HashSet;

use serde::Deserialize;
use wick_platform::MouseButton;

/// One OS-level action, in frame pixels where a position is involved.
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    MoveTo { x: f64, y: f64 },
    Turn { dx: f64, dy: f64 },
    Button { button: MouseButton, down: bool },
    Key { name: String, down: bool },
}

/// A point given as a region name plus fractions of that region.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct At {
    pub region: Option<String>,
    pub x: f64,
    pub y: f64,
}

/// Input commands as macros queue them.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Command {
    Click {
        button: String,
        at: Option<At>,
        hold: f64,
    },
    MouseDown {
        button: String,
    },
    MouseUp {
        button: String,
    },
    Move {
        at: At,
    },
    Turn {
        dx: f64,
        dy: f64,
    },
    Press {
        key: String,
        hold: f64,
    },
    KeyDown {
        key: String,
    },
    KeyUp {
        key: String,
    },
}

impl Command {
    pub fn permission(&self) -> &'static str {
        match self {
            Command::Click { .. } | Command::MouseDown { .. } | Command::MouseUp { .. } => {
                "mouse.click"
            }
            Command::Move { .. } | Command::Turn { .. } => "mouse.move",
            Command::Press { .. } | Command::KeyDown { .. } | Command::KeyUp { .. } => "keyboard",
        }
    }
}

fn button(name: &str) -> Result<MouseButton, String> {
    MouseButton::parse(name)
        .ok_or_else(|| format!("Unknown mouse button \"{name}\". Use left, right or middle."))
}

fn key(name: &str) -> Result<String, String> {
    let name = name.to_ascii_lowercase();
    if wick_platform::keys::mac_code(&name).is_none()
        && wick_platform::keys::windows_code(&name).is_none()
    {
        return Err(format!("Unknown key \"{name}\"."));
    }
    Ok(name)
}

/// Pending and held input for one macro run.
#[derive(Default)]
pub struct InputState {
    /// Actions scheduled for later, by time in ms.
    scheduled: Vec<(f64, Action)>,
    held_buttons: HashSet<MouseButton>,
    held_keys: HashSet<String>,
    pub sent: u64,
    pub dropped: u64,
}

impl InputState {
    /// Expands a command into actions, now and later. `locate` maps a region
    /// point to frame pixels.
    pub fn schedule(
        &mut self,
        cmd: Command,
        now: f64,
        locate: impl Fn(&At) -> Result<(f64, f64), String>,
    ) -> Result<(), String> {
        let mut at = |t: f64, a: Action| self.scheduled.push((t, a));
        match cmd {
            Command::Click {
                button: b,
                at: point,
                hold,
            } => {
                let b = button(&b)?;
                if let Some(point) = point {
                    let (x, y) = locate(&point)?;
                    at(now, Action::MoveTo { x, y });
                }
                at(
                    now,
                    Action::Button {
                        button: b,
                        down: true,
                    },
                );
                at(
                    now + hold.max(0.0),
                    Action::Button {
                        button: b,
                        down: false,
                    },
                );
            }
            Command::MouseDown { button: b } => at(
                now,
                Action::Button {
                    button: button(&b)?,
                    down: true,
                },
            ),
            Command::MouseUp { button: b } => at(
                now,
                Action::Button {
                    button: button(&b)?,
                    down: false,
                },
            ),
            Command::Move { at: point } => {
                let (x, y) = locate(&point)?;
                at(now, Action::MoveTo { x, y });
            }
            Command::Turn { dx, dy } => at(now, Action::Turn { dx, dy }),
            Command::Press { key: k, hold } => {
                let k = key(&k)?;
                at(
                    now,
                    Action::Key {
                        name: k.clone(),
                        down: true,
                    },
                );
                at(
                    now + hold.max(0.0),
                    Action::Key {
                        name: k,
                        down: false,
                    },
                );
            }
            Command::KeyDown { key: k } => at(
                now,
                Action::Key {
                    name: key(&k)?,
                    down: true,
                },
            ),
            Command::KeyUp { key: k } => at(
                now,
                Action::Key {
                    name: key(&k)?,
                    down: false,
                },
            ),
        }
        Ok(())
    }

    /// Sends everything due by `now`, in order. Input is dropped while the
    /// target isn't focused.
    pub fn flush(
        &mut self,
        now: f64,
        focused: bool,
        send: &mut dyn FnMut(&Action) -> Result<(), String>,
    ) -> Result<(), String> {
        self.scheduled.sort_by(|a, b| a.0.total_cmp(&b.0));
        let due = self.scheduled.iter().take_while(|(t, _)| *t <= now).count();
        for (_, action) in self.scheduled.drain(..due).collect::<Vec<_>>() {
            if !focused {
                self.dropped += 1;
                continue;
            }
            send(&action)?;
            self.sent += 1;
            match &action {
                Action::Button { button, down: true } => {
                    self.held_buttons.insert(*button);
                }
                Action::Button {
                    button,
                    down: false,
                } => {
                    self.held_buttons.remove(button);
                }
                Action::Key { name, down: true } => {
                    self.held_keys.insert(name.clone());
                }
                Action::Key { name, down: false } => {
                    self.held_keys.remove(name);
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// Releases anything still held, if the target is focused, and clears the schedule.
    pub fn release_all(
        &mut self,
        focused: bool,
        send: &mut dyn FnMut(&Action) -> Result<(), String>,
    ) {
        self.scheduled.clear();
        let buttons: Vec<_> = self.held_buttons.drain().collect();
        let keys: Vec<_> = self.held_keys.drain().collect();
        if !focused {
            return;
        }
        for button in buttons {
            let _ = send(&Action::Button {
                button,
                down: false,
            });
        }
        for name in keys {
            let _ = send(&Action::Key { name, down: false });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn locate(_: &At) -> Result<(f64, f64), String> {
        Ok((10.0, 20.0))
    }

    fn collect(state: &mut InputState, now: f64, focused: bool) -> Vec<Action> {
        let mut out = Vec::new();
        state
            .flush(now, focused, &mut |a| {
                out.push(a.clone());
                Ok(())
            })
            .unwrap();
        out
    }

    #[test]
    fn click_moves_presses_then_releases_later() {
        let mut s = InputState::default();
        let cmd: Command = serde_json::from_str(
            r#"{"t":"click","button":"left","at":{"region":"bar","x":0.5,"y":0.5},"hold":30}"#,
        )
        .unwrap();
        s.schedule(cmd, 100.0, locate).unwrap();
        assert_eq!(
            collect(&mut s, 100.0, true),
            vec![
                Action::MoveTo { x: 10.0, y: 20.0 },
                Action::Button {
                    button: MouseButton::Left,
                    down: true
                }
            ]
        );
        assert!(collect(&mut s, 120.0, true).is_empty());
        assert_eq!(
            collect(&mut s, 130.0, true),
            vec![Action::Button {
                button: MouseButton::Left,
                down: false
            }]
        );
    }

    #[test]
    fn drops_input_while_unfocused() {
        let mut s = InputState::default();
        s.schedule(Command::KeyDown { key: "W".into() }, 0.0, locate)
            .unwrap();
        assert!(collect(&mut s, 0.0, false).is_empty());
        assert_eq!(s.dropped, 1);
    }

    #[test]
    fn releases_held_input() {
        let mut s = InputState::default();
        s.schedule(Command::KeyDown { key: "w".into() }, 0.0, locate)
            .unwrap();
        s.schedule(
            Command::MouseDown {
                button: "right".into(),
            },
            0.0,
            locate,
        )
        .unwrap();
        collect(&mut s, 0.0, true);
        let mut released = Vec::new();
        s.release_all(true, &mut |a| {
            released.push(a.clone());
            Ok(())
        });
        assert_eq!(released.len(), 2);
        assert!(released.contains(&Action::Key {
            name: "w".into(),
            down: false
        }));
    }

    #[test]
    fn maps_permissions_and_rejects_unknown_names() {
        assert_eq!(
            Command::Turn { dx: 1.0, dy: 0.0 }.permission(),
            "mouse.move"
        );
        assert_eq!(
            Command::Press {
                key: "e".into(),
                hold: 10.0
            }
            .permission(),
            "keyboard"
        );
        let mut s = InputState::default();
        assert!(s
            .schedule(
                Command::Press {
                    key: "hyper".into(),
                    hold: 1.0
                },
                0.0,
                locate
            )
            .is_err());
        assert!(s
            .schedule(
                Command::MouseDown {
                    button: "fourth".into()
                },
                0.0,
                locate
            )
            .is_err());
    }
}
