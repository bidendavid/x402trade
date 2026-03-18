// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AgentExchangeCore
/// @notice AMM exchange for AI Agent trading on Base L2.
///         Uses constant-product formula (x * y = k) with 0.3% fee.
contract AgentExchangeCore is ReentrancyGuard {

    struct TradingPair {
        address token0;
        address token1;
        uint256 reserve0;
        uint256 reserve1;
        uint256 totalLiquidity;
        bool active;
    }

    struct Trade {
        uint256 id;
        address agent;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 amountOut;
        uint256 timestamp;
    }

    mapping(bytes32 => TradingPair) public pairs;
    mapping(bytes32 => Trade[]) public tradeHistory;
    uint256 public tradeCount;

    address public admin;
    address public immutable usdcToken;

    event PairCreated(bytes32 indexed pairId, address indexed token0, address indexed token1);
    event TradeExecuted(
        uint256 indexed tradeId,
        address indexed agent,
        bytes32 indexed pairId,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );
    event LiquidityAdded(bytes32 indexed pairId, address indexed provider, uint256 amount0, uint256 amount1);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Not admin");
        _;
    }

    modifier pairActive(bytes32 pairId) {
        require(pairs[pairId].active, "Pair not active");
        _;
    }

    constructor(address _usdcToken) {
        require(_usdcToken != address(0), "Invalid USDC address");
        admin = msg.sender;
        usdcToken = _usdcToken;
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "Invalid address");
        admin = newAdmin;
    }

    /// @notice Create a new AMM trading pair
    function createPair(address token0, address token1) external onlyAdmin returns (bytes32 pairId) {
        require(token0 != address(0) && token1 != address(0), "Invalid token");
        require(token0 != token1, "Same tokens");
        pairId = keccak256(abi.encodePacked(token0, token1));
        require(pairs[pairId].token0 == address(0), "Pair exists");

        pairs[pairId] = TradingPair({
            token0: token0,
            token1: token1,
            reserve0: 0,
            reserve1: 0,
            totalLiquidity: 0,
            active: true
        });

        emit PairCreated(pairId, token0, token1);
    }

    function setPairActive(bytes32 pairId, bool active) external onlyAdmin {
        require(pairs[pairId].token0 != address(0), "Pair not found");
        pairs[pairId].active = active;
    }

    /// @notice Execute a swap via constant-product AMM
    /// @param pairId  The trading pair
    /// @param tokenIn Token being sold
    /// @param amountIn Amount to sell
    /// @param amountOutMin Slippage protection
    function executeTrade(
        bytes32 pairId,
        address tokenIn,
        uint256 amountIn,
        uint256 amountOutMin
    ) external nonReentrant pairActive(pairId) returns (uint256 amountOut) {
        TradingPair storage pair = pairs[pairId];
        require(tokenIn == pair.token0 || tokenIn == pair.token1, "Invalid token");
        require(amountIn > 0, "Zero amount");

        address tokenOut;
        uint256 reserveIn;
        uint256 reserveOut;

        if (tokenIn == pair.token0) {
            tokenOut = pair.token1;
            reserveIn  = pair.reserve0;
            reserveOut = pair.reserve1;
        } else {
            tokenOut = pair.token0;
            reserveIn  = pair.reserve1;
            reserveOut = pair.reserve0;
        }

        require(reserveIn > 0 && reserveOut > 0, "Insufficient liquidity");

        amountOut = getAmountOut(amountIn, reserveIn, reserveOut);
        require(amountOut >= amountOutMin, "Slippage exceeded");
        require(amountOut < reserveOut, "Insufficient reserve");

        if (tokenIn == pair.token0) {
            pair.reserve0 += amountIn;
            pair.reserve1 -= amountOut;
        } else {
            pair.reserve1 += amountIn;
            pair.reserve0 -= amountOut;
        }

        require(IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn), "TransferFrom failed");
        require(IERC20(tokenOut).transfer(msg.sender, amountOut), "Transfer failed");

        uint256 tradeId = ++tradeCount;
        tradeHistory[pairId].push(Trade({
            id: tradeId,
            agent: msg.sender,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            amountOut: amountOut,
            timestamp: block.timestamp
        }));

        emit TradeExecuted(tradeId, msg.sender, pairId, tokenIn, tokenOut, amountIn, amountOut);
    }

    /// @notice Add liquidity to a pair
    function addLiquidity(
        bytes32 pairId,
        uint256 amount0,
        uint256 amount1
    ) external nonReentrant pairActive(pairId) returns (uint256 liquidity) {
        TradingPair storage pair = pairs[pairId];
        require(amount0 > 0 && amount1 > 0, "Zero amounts");

        require(IERC20(pair.token0).transferFrom(msg.sender, address(this), amount0), "Token0 transfer failed");
        require(IERC20(pair.token1).transferFrom(msg.sender, address(this), amount1), "Token1 transfer failed");

        pair.reserve0 += amount0;
        pair.reserve1 += amount1;
        liquidity = amount0 + amount1;
        pair.totalLiquidity += liquidity;

        emit LiquidityAdded(pairId, msg.sender, amount0, amount1);
    }

    /// @notice Constant-product output formula with 0.3% fee
    function getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) public pure returns (uint256) {
        require(amountIn > 0, "Insufficient input");
        require(reserveIn > 0 && reserveOut > 0, "Insufficient liquidity");
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = (reserveIn * 1000) + amountInWithFee;
        return numerator / denominator;
    }

    function getPair(bytes32 pairId) external view returns (
        address token0, address token1,
        uint256 reserve0, uint256 reserve1,
        uint256 totalLiquidity, bool active
    ) {
        TradingPair memory p = pairs[pairId];
        return (p.token0, p.token1, p.reserve0, p.reserve1, p.totalLiquidity, p.active);
    }

    function getPairId(address token0, address token1) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(token0, token1));
    }

    function getTradeHistory(
        bytes32 pairId,
        uint256 offset,
        uint256 limit
    ) external view returns (Trade[] memory result) {
        Trade[] storage all = tradeHistory[pairId];
        if (offset >= all.length) return new Trade[](0);
        uint256 end = offset + limit > all.length ? all.length : offset + limit;
        result = new Trade[](end - offset);
        for (uint256 i = 0; i < result.length; i++) {
            result[i] = all[offset + i];
        }
    }
}
