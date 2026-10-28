//! Key names macros use, mapped to each platform's key codes.
//!
//! Names are lowercase: letters `a`–`z`, digits `0`–`9`, `f1`–`f12`, and
//! `space`, `enter`, `escape`, `tab`, `backspace`, `shift`, `control`, `alt`,
//! `command`, `up`, `down`, `left`, `right`, `minus`, `equal`, `comma`,
//! `period`, `slash`, `semicolon`, `quote`, `backquote`, `leftbracket`,
//! `rightbracket`, `backslash`.

/// macOS virtual key codes (`kVK_*`).
pub fn mac_code(name: &str) -> Option<u32> {
    let code = match name {
        "a" => 0,
        "s" => 1,
        "d" => 2,
        "f" => 3,
        "h" => 4,
        "g" => 5,
        "z" => 6,
        "x" => 7,
        "c" => 8,
        "v" => 9,
        "b" => 11,
        "q" => 12,
        "w" => 13,
        "e" => 14,
        "r" => 15,
        "y" => 16,
        "t" => 17,
        "1" => 18,
        "2" => 19,
        "3" => 20,
        "4" => 21,
        "6" => 22,
        "5" => 23,
        "equal" => 24,
        "9" => 25,
        "7" => 26,
        "minus" => 27,
        "8" => 28,
        "0" => 29,
        "rightbracket" => 30,
        "o" => 31,
        "u" => 32,
        "leftbracket" => 33,
        "i" => 34,
        "p" => 35,
        "enter" => 36,
        "l" => 37,
        "j" => 38,
        "quote" => 39,
        "k" => 40,
        "semicolon" => 41,
        "backslash" => 42,
        "comma" => 43,
        "slash" => 44,
        "n" => 45,
        "m" => 46,
        "period" => 47,
        "tab" => 48,
        "space" => 49,
        "backquote" => 50,
        "backspace" => 51,
        "escape" => 53,
        "command" => 55,
        "shift" => 56,
        "alt" => 58,
        "control" => 59,
        "f5" => 96,
        "f6" => 97,
        "f7" => 98,
        "f3" => 99,
        "f8" => 100,
        "f9" => 101,
        "f11" => 103,
        "f10" => 109,
        "f12" => 111,
        "f4" => 118,
        "f2" => 120,
        "f1" => 122,
        "left" => 123,
        "right" => 124,
        "down" => 125,
        "up" => 126,
        _ => return None,
    };
    Some(code)
}

/// Windows virtual-key codes (`VK_*`).
pub fn windows_code(name: &str) -> Option<u32> {
    let bytes = name.as_bytes();
    if bytes.len() == 1 {
        let c = bytes[0];
        if c.is_ascii_lowercase() {
            return Some(u32::from(c.to_ascii_uppercase()));
        }
        if c.is_ascii_digit() {
            return Some(u32::from(c));
        }
    }
    if let Some(n) = name.strip_prefix('f').and_then(|n| n.parse::<u32>().ok()) {
        if (1..=12).contains(&n) {
            return Some(0x6F + n);
        }
    }
    let code = match name {
        "backspace" => 0x08,
        "tab" => 0x09,
        "enter" => 0x0D,
        "shift" => 0x10,
        "control" => 0x11,
        "alt" => 0x12,
        "escape" => 0x1B,
        "space" => 0x20,
        "left" => 0x25,
        "up" => 0x26,
        "right" => 0x27,
        "down" => 0x28,
        "command" => 0x5B,
        "semicolon" => 0xBA,
        "equal" => 0xBB,
        "comma" => 0xBC,
        "minus" => 0xBD,
        "period" => 0xBE,
        "slash" => 0xBF,
        "backquote" => 0xC0,
        "leftbracket" => 0xDB,
        "backslash" => 0xDC,
        "rightbracket" => 0xDD,
        "quote" => 0xDE,
        _ => return None,
    };
    Some(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_common_keys_on_both_platforms() {
        for name in ["a", "z", "0", "9", "space", "enter", "escape", "f1", "f8", "f12", "up", "shift"] {
            assert!(mac_code(name).is_some(), "mac {name}");
            assert!(windows_code(name).is_some(), "windows {name}");
        }
        assert_eq!(windows_code("a"), Some(0x41));
        assert_eq!(windows_code("f8"), Some(0x77));
        assert_eq!(mac_code("f8"), Some(100));
        assert_eq!(mac_code("nope"), None);
        assert_eq!(windows_code("f13"), None);
    }
}
