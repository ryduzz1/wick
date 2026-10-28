//! The Roblox target's own actions. Both are ordinary things a player does:
//! the reset key sequence, and Roblox's public `roblox://` link to join a
//! place. Nothing here reads, opens or talks to the Roblox process.

use crate::human::Step;
use crate::input::Action;
use crate::target::GameInfo;

/// Esc opens the menu, R picks Reset Character, Enter confirms. The pauses
/// give the menu time to open and animate.
pub fn reset_plan() -> Vec<Step> {
    let key = |name: &str, at: f64, down: bool| Step {
        at,
        action: Action::Key {
            name: name.into(),
            down,
        },
    };
    vec![
        key("escape", 0.0, true),
        key("escape", 50.0, false),
        key("r", 600.0, true),
        key("r", 650.0, false),
        key("enter", 1200.0, true),
        key("enter", 1250.0, false),
    ]
}

pub fn rejoin_url(place_id: u64) -> String {
    format!("roblox://experiences/start?placeId={place_id}")
}

pub fn special(name: &str, game: &GameInfo) -> Result<Vec<Step>, String> {
    match name {
        "character.reset" => Ok(reset_plan()),
        "game.rejoin" => {
            let id = game.place_id.ok_or(
                "Rejoining needs the game's place ID: add \"game\": { \"placeId\": 123 } to wick.json.",
            )?;
            wick_platform::open_url(&rejoin_url(id))?;
            Ok(Vec::new())
        }
        other => Err(format!("\"{other}\" isn't a Roblox action.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reset_presses_escape_r_enter_in_order() {
        let keys: Vec<_> = reset_plan()
            .into_iter()
            .filter_map(|s| match s.action {
                Action::Key { name, down: true } => Some(name),
                _ => None,
            })
            .collect();
        assert_eq!(keys, ["escape", "r", "enter"]);
    }

    #[test]
    fn rejoin_needs_a_place_id() {
        assert_eq!(rejoin_url(1818), "roblox://experiences/start?placeId=1818");
        let err = special("game.rejoin", &GameInfo::default()).unwrap_err();
        assert!(err.contains("placeId"), "{err}");
    }
}
