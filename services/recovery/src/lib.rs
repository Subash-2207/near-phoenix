//! Local-only PHOENIX coordinator and STATEFLOW. Workers never hold NEAR keys.
#![allow(async_fn_in_trait)]
pub mod coordinator;
pub mod stateflow;
pub use coordinator::*;
pub use stateflow::*;
pub mod guardian;
#[cfg(test)]
mod security_tests;
pub mod sentinel;
#[cfg(test)]
mod tests;
