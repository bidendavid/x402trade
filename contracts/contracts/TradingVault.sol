// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title TradingVault
/// @notice Custodian contract for x402Trade user funds.
///         Users deposit USDC / ETH here; the exchange backend settles trades
///         by moving balances internally. Platform never holds user funds in
///         a plain EOA wallet — only this contract controls them.
///
///         Trust model:
///           - Users can ALWAYS withdraw their own balance directly (no admin approval).
///           - Only the authorized exchange backend can call `settle()`.
///           - Owner can rotate the exchange address but cannot touch user funds.
///           - Trade fees are credited to a dedicated fee wallet, also in the contract.
contract TradingVault is Ownable, ReentrancyGuard {

    // ── State ──────────────────────────────────────────────────────────────────

    IERC20 public immutable usdc;

    /// @dev exchange backend address — the only account allowed to settle trades
    address public exchangeBackend;

    /// @dev platform fee wallet — receives fee cuts from settlements
    address public feeWallet;

    /// @dev fee rate in basis points (e.g. 10 = 0.10%)
    uint256 public feeBps = 10;

    /// @dev per-user balances held in this contract
    mapping(address => uint256) public usdcBalance;
    mapping(address => uint256) public ethBalance;

    // ── Events ─────────────────────────────────────────────────────────────────

    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event Settled(
        address indexed buyer,
        address indexed seller,
        uint256 usdcAmount,
        uint256 ethAmount,
        uint256 fee
    );
    event ExchangeBackendChanged(address indexed oldBackend, address indexed newBackend);
    event FeeWalletChanged(address indexed oldWallet, address indexed newWallet);
    event FeeBpsChanged(uint256 oldBps, uint256 newBps);

    // ── Modifiers ──────────────────────────────────────────────────────────────

    modifier onlyExchange() {
        require(msg.sender == exchangeBackend, "TradingVault: not exchange");
        _;
    }

    // ── Constructor ────────────────────────────────────────────────────────────

    /// @param _usdc        USDC token address on Base (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
    /// @param _backend     Initial exchange backend address
    /// @param _feeWallet   Address that receives platform fees
    constructor(
        address _usdc,
        address _backend,
        address _feeWallet
    ) Ownable(msg.sender) {
        require(_usdc      != address(0), "Invalid USDC");
        require(_backend   != address(0), "Invalid backend");
        require(_feeWallet != address(0), "Invalid feeWallet");
        usdc            = IERC20(_usdc);
        exchangeBackend = _backend;
        feeWallet       = _feeWallet;
    }

    // ── Deposit ────────────────────────────────────────────────────────────────

    /// @notice Deposit USDC into the vault. Approve this contract first.
    function depositUsdc(uint256 amount) external nonReentrant {
        require(amount > 0, "Zero amount");
        usdc.transferFrom(msg.sender, address(this), amount);
        usdcBalance[msg.sender] += amount;
        emit Deposited(msg.sender, address(usdc), amount);
    }

    /// @notice Deposit ETH into the vault.
    function depositEth() external payable nonReentrant {
        require(msg.value > 0, "Zero amount");
        ethBalance[msg.sender] += msg.value;
        emit Deposited(msg.sender, address(0), msg.value);
    }

    // ── Withdraw ───────────────────────────────────────────────────────────────

    /// @notice Withdraw USDC directly — no admin approval required.
    function withdrawUsdc(uint256 amount) external nonReentrant {
        require(amount > 0, "Zero amount");
        require(usdcBalance[msg.sender] >= amount, "Insufficient USDC");
        usdcBalance[msg.sender] -= amount;
        usdc.transfer(msg.sender, amount);
        emit Withdrawn(msg.sender, address(usdc), amount);
    }

    /// @notice Withdraw ETH directly — no admin approval required.
    function withdrawEth(uint256 amount) external nonReentrant {
        require(amount > 0, "Zero amount");
        require(ethBalance[msg.sender] >= amount, "Insufficient ETH");
        ethBalance[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "ETH transfer failed");
        emit Withdrawn(msg.sender, address(0), amount);
    }

    // ── Settlement ─────────────────────────────────────────────────────────────

    /// @notice Settle a matched trade. Called by the exchange backend only.
    ///
    ///         For a BUY order (buyer wants ETH, pays USDC):
    ///           - buyer's  USDC decreases by (usdcAmount + fee)
    ///           - seller's USDC increases by  usdcAmount
    ///           - seller's ETH  decreases by  ethAmount
    ///           - buyer's  ETH  increases by  ethAmount
    ///           - fee wallet's  USDC increases by fee
    ///
    /// @param buyer       Address of the buying agent
    /// @param seller      Address of the selling agent
    /// @param usdcAmount  USDC paid by buyer to seller (excluding fee), 6 decimals
    /// @param ethAmount   ETH transferred from seller to buyer, 18 decimals (wei)
    function settle(
        address buyer,
        address seller,
        uint256 usdcAmount,
        uint256 ethAmount
    ) external onlyExchange nonReentrant {
        require(buyer  != address(0), "Invalid buyer");
        require(seller != address(0), "Invalid seller");
        require(buyer  != seller,     "Self-trade");
        require(usdcAmount > 0,       "Zero USDC");
        require(ethAmount  > 0,       "Zero ETH");

        // Calculate fee on the USDC leg
        uint256 fee = (usdcAmount * feeBps) / 10_000;
        uint256 totalUsdc = usdcAmount + fee;

        // Check balances
        require(usdcBalance[buyer]  >= totalUsdc, "Buyer: insufficient USDC");
        require(ethBalance[seller]  >= ethAmount, "Seller: insufficient ETH");

        // Move USDC: buyer → seller + fee wallet
        usdcBalance[buyer]     -= totalUsdc;
        usdcBalance[seller]    += usdcAmount;
        usdcBalance[feeWallet] += fee;

        // Move ETH: seller → buyer
        ethBalance[seller] -= ethAmount;
        ethBalance[buyer]  += ethAmount;

        emit Settled(buyer, seller, usdcAmount, ethAmount, fee);
    }

    // ── View helpers ───────────────────────────────────────────────────────────

    function balanceOf(address user) external view returns (uint256 _usdc, uint256 _eth) {
        return (usdcBalance[user], ethBalance[user]);
    }

    // ── Admin ──────────────────────────────────────────────────────────────────

    /// @notice Rotate exchange backend address (e.g. after server migration).
    ///         Does NOT affect user funds.
    function setExchangeBackend(address newBackend) external onlyOwner {
        require(newBackend != address(0), "Invalid address");
        emit ExchangeBackendChanged(exchangeBackend, newBackend);
        exchangeBackend = newBackend;
    }

    /// @notice Change the fee collection wallet.
    function setFeeWallet(address newWallet) external onlyOwner {
        require(newWallet != address(0), "Invalid address");
        emit FeeWalletChanged(feeWallet, newWallet);
        feeWallet = newWallet;
    }

    /// @notice Adjust the trade fee rate (max 1% = 100 bps).
    function setFeeBps(uint256 newBps) external onlyOwner {
        require(newBps <= 100, "Fee too high");
        emit FeeBpsChanged(feeBps, newBps);
        feeBps = newBps;
    }

    // ── ETH receiver ──────────────────────────────────────────────────────────

    receive() external payable {
        // Direct ETH sends treated as deposit for msg.sender
        ethBalance[msg.sender] += msg.value;
        emit Deposited(msg.sender, address(0), msg.value);
    }
}
