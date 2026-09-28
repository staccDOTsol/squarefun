// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ReferenceFeeERC20} from "./ReferenceFeeERC20.sol";

/// @dev The protocol addresses a launch token never counts as references.
interface IPonsV2ProtocolAddresses {
    function memeHook() external view returns (address);
    function buybackVault() external view returns (address);
    function locker() external view returns (address);
    function graduationExecutor() external view returns (address);
}

/**
 * @title PonsV2LauncherToken
 * @notice Fixed-supply ERC-20 deployed by PonsV2LaunchFactory for a v2 launch.
 * The entire supply mints directly to the token's bonding curve instead of a
 * Uniswap position. Anyone, the deployer included, may buy any amount from
 * the curve at any time; the curve's own price impact and its reserved pool
 * allocation are the only limits on a large buy. `deployer` is carried here
 * as immutable reference data for off-chain attribution only, and confers no
 * privileges over the token.
 * `ERC20Burnable` lets any holder voluntarily burn their own balance; the
 * protocol's buyback mechanism does not use it, bought-back tokens are
 * locked into `PonsV2BuybackVault` for a five-year vest instead of being
 * burned.
 *
 * This fork makes every launch token an IERC12384 token (ReferenceFeeERC20):
 * transfers are counted per block, and the k-th one in a block pays
 * 10 bp * k² in kind, half to the sealed sink and half to the factory's
 * reference beneficiary (the SquareSink). The protocol's own movements are not
 * references: the curve selling to buyers, the factory and graduation executor
 * seeding the pool, the hook and buyback vault handling fees, and the locker.
 * Everything else, on any venue, counts. That is what makes a launch here
 * expensive to walk: fifty-nine pools, a price ladder, or a same-block add and
 * remove all reference the token many times in one block, and the machine pays
 * for every one of them after the first.
 */
contract PonsV2LauncherToken is ERC20, ERC20Burnable, ReferenceFeeERC20 {
    struct Socials {
        string twitter;
        string telegram;
        string discord;
        string website;
        string farcaster;
    }

    error ZeroAddress();

    address public immutable deployer;
    address public immutable launchFactory;
    address public immutable curve;
    address public immutable memeHook;
    address public immutable buybackVault;
    address public immutable locker;
    address public immutable graduationExecutor;

    string public logo;
    string public description;

    Socials private _socials;

    /**
     * @notice Creates a v2 launch token and mints its entire supply to the bonding curve.
     */
    constructor(
        string memory name_,
        string memory symbol_,
        string memory logo_,
        string memory description_,
        Socials memory socials_,
        address deployer_,
        address curve_,
        address launchFactory_,
        uint256 supply_,
        address referenceBeneficiary_
    ) ERC20(name_, symbol_) ReferenceFeeERC20(referenceBeneficiary_) {
        if (deployer_ == address(0) || curve_ == address(0) || launchFactory_ == address(0)) {
            revert ZeroAddress();
        }

        deployer = deployer_;
        // Passed explicitly rather than read from msg.sender: PonsV2LaunchFactory
        // deploys this token indirectly through PonsV2LaunchDeployer to keep its
        // own bytecode under EIP-170's size limit, so msg.sender at construction
        // time would otherwise resolve to that deployer helper, not the factory.
        launchFactory = launchFactory_;
        curve = curve_;
        logo = logo_;
        description = description_;
        _socials = socials_;

        IPonsV2ProtocolAddresses f = IPonsV2ProtocolAddresses(launchFactory_);
        memeHook = f.memeHook();
        buybackVault = f.buybackVault();
        locker = f.locker();
        graduationExecutor = f.graduationExecutor();

        _mint(curve_, supply_);
    }

    /// @dev Protocol plumbing is not a reference.
    function _isProtocol(address a) internal view returns (bool) {
        return a == curve || a == launchFactory || a == memeHook || a == buybackVault || a == locker
            || a == graduationExecutor;
    }

    function _counted(address from, address to) internal view override returns (bool) {
        if (_isProtocol(from) || _isProtocol(to)) return false;
        return super._counted(from, to);
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ReferenceFeeERC20) {
        ReferenceFeeERC20._update(from, to, value);
    }

    /**
     * @notice Returns the launch token's five social metadata fields.
     */
    function socials()
        external
        view
        returns (
            string memory twitter,
            string memory telegram,
            string memory discord,
            string memory website,
            string memory farcaster
        )
    {
        Socials memory values = _socials;
        return (values.twitter, values.telegram, values.discord, values.website, values.farcaster);
    }

    /**
     * @notice Returns creator and metadata in the launcher-compatible tuple.
     */
    function getTokenInfo()
        external
        view
        returns (
            address tokenDeployer,
            string memory tokenLogo,
            string memory tokenDescription,
            Socials memory tokenSocials
        )
    {
        return (deployer, logo, description, _socials);
    }
}
