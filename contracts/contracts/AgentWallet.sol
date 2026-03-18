// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title AgentWallet
/// @notice AI Agent registration, staking, and reputation management on Base L2.
///         Agents stake USDC to participate; malicious agents can be slashed.
contract AgentWallet is Ownable, ReentrancyGuard {

    struct Agent {
        address wallet;
        uint256 stake;
        uint256 score;       // 0–100, starts at 100
        uint256 lastActive;
        bool active;
    }

    mapping(address => Agent) public agents;
    mapping(address => bool) public blacklisted;

    uint256 public minStake = 100 * 10 ** 6;  // 100 USDC (6 decimals)
    uint256 public totalAgents;
    uint256 public totalStaked;

    address public immutable usdcToken;
    address public scoreUpdater;   // authorized backend signer

    event AgentRegistered(address indexed agent, uint256 stake);
    event AgentStaked(address indexed agent, uint256 amount);
    event AgentUnstaked(address indexed agent, uint256 amount);
    event AgentBlacklisted(address indexed agent, uint256 slashedStake);
    event AgentDeactivated(address indexed agent);
    event ScoreUpdated(address indexed agent, uint256 oldScore, uint256 newScore);
    event MinStakeChanged(uint256 oldMin, uint256 newMin);
    event ScoreUpdaterChanged(address indexed oldUpdater, address indexed newUpdater);

    modifier onlyActiveAgent() {
        require(agents[msg.sender].active, "Agent not active");
        _;
    }

    modifier notBlacklisted() {
        require(!blacklisted[msg.sender], "Agent blacklisted");
        _;
    }

    modifier onlyScoreUpdater() {
        require(msg.sender == scoreUpdater || msg.sender == owner(), "Not authorized");
        _;
    }

    constructor(address _usdcToken) Ownable(msg.sender) {
        require(_usdcToken != address(0), "Invalid USDC");
        usdcToken = _usdcToken;
        scoreUpdater = msg.sender;
    }

    /// @notice Register as an AI Agent by staking the minimum USDC
    function register() external notBlacklisted nonReentrant {
        require(agents[msg.sender].wallet == address(0), "Already registered");

        IERC20(usdcToken).transferFrom(msg.sender, address(this), minStake);

        agents[msg.sender] = Agent({
            wallet: msg.sender,
            stake: minStake,
            score: 100,
            lastActive: block.timestamp,
            active: true
        });

        totalAgents++;
        totalStaked += minStake;

        emit AgentRegistered(msg.sender, minStake);
    }

    /// @notice Top up stake
    function addStake(uint256 amount) external onlyActiveAgent nonReentrant {
        require(amount > 0, "Zero amount");
        IERC20(usdcToken).transferFrom(msg.sender, address(this), amount);
        agents[msg.sender].stake += amount;
        totalStaked += amount;
        emit AgentStaked(msg.sender, amount);
    }

    /// @notice Withdraw excess stake (must keep at least minStake)
    function unstake(uint256 amount) external onlyActiveAgent nonReentrant {
        Agent storage a = agents[msg.sender];
        require(amount > 0, "Zero amount");
        require(a.stake >= amount, "Insufficient stake");
        require(a.stake - amount >= minStake, "Below minimum stake");

        a.stake -= amount;
        totalStaked -= amount;
        IERC20(usdcToken).transfer(msg.sender, amount);
        emit AgentUnstaked(msg.sender, amount);
    }

    /// @notice Update agent reputation score (authorized backend only)
    function updateScore(address agentAddr, int256 delta) external onlyScoreUpdater {
        Agent storage a = agents[agentAddr];
        require(a.active, "Agent not active");

        uint256 old = a.score;
        if (delta >= 0) {
            a.score = old + uint256(delta) > 100 ? 100 : old + uint256(delta);
        } else {
            uint256 penalty = uint256(-delta);
            a.score = old > penalty ? old - penalty : 0;
        }
        a.lastActive = block.timestamp;

        emit ScoreUpdated(agentAddr, old, a.score);
    }

    /// @notice Blacklist and slash a malicious agent's stake
    function blacklist(address agentAddr) external onlyOwner {
        Agent storage a = agents[agentAddr];
        require(a.active, "Not active");
        require(!blacklisted[agentAddr], "Already blacklisted");

        uint256 slashed = a.stake;
        a.active = false;
        a.stake = 0;
        blacklisted[agentAddr] = true;
        totalStaked -= slashed;

        if (slashed > 0) IERC20(usdcToken).transfer(owner(), slashed);

        emit AgentBlacklisted(agentAddr, slashed);
    }

    /// @notice Voluntarily exit and recover stake
    function deactivate() external onlyActiveAgent nonReentrant {
        Agent storage a = agents[msg.sender];
        uint256 stake = a.stake;
        a.active = false;
        a.stake = 0;
        totalStaked -= stake;
        totalAgents--;

        if (stake > 0) IERC20(usdcToken).transfer(msg.sender, stake);
        emit AgentDeactivated(msg.sender);
    }

    function getAgent(address agentAddr) external view returns (
        address wallet, uint256 stake, uint256 score, uint256 lastActive, bool active
    ) {
        Agent memory a = agents[agentAddr];
        return (a.wallet, a.stake, a.score, a.lastActive, a.active);
    }

    function isActiveAgent(address agentAddr) external view returns (bool) {
        return agents[agentAddr].active && !blacklisted[agentAddr];
    }

    function setMinStake(uint256 newMin) external onlyOwner {
        emit MinStakeChanged(minStake, newMin);
        minStake = newMin;
    }

    function setScoreUpdater(address newUpdater) external onlyOwner {
        require(newUpdater != address(0), "Invalid address");
        emit ScoreUpdaterChanged(scoreUpdater, newUpdater);
        scoreUpdater = newUpdater;
    }
}
