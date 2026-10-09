<?php

$startTime = microtime(true);

// Caching
// header('Cache-Control: public, max-age=300');
// header('Expires: '.gmdate('r', time() + 300));
// header('Pragma: cache');
// header('Content-Type: text/html; charset=UTF-8');

require_once('config.php');
require_once('settings.php');
require_once('masks.inc.php');
require('lib.inc.php');

$system = $_REQUEST['system'];
?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
	<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
	<meta name="system" content="<?= $system ?>">
	<meta name="server" content="<?= CDN_DOMAIN ?>">
	<meta name="app_name" content="<?= APP_NAME ?>">
	<meta name="version" content="<?= VERSION ?>">
	<link rel="shortcut icon" href="//<?= CDN_DOMAIN ?>/images/favicon.png" />

	<link rel="stylesheet" type="text/css" href="//<?= CDN_DOMAIN ?>/css/jquery.duration-picker.css">
	<link rel="stylesheet" type="text/css" href="//<?= CDN_DOMAIN ?>/css/jquery.jbox.css">
	<link rel="stylesheet" type="text/css" href="//<?= CDN_DOMAIN ?>/css/jquery.jbox-notice.css">
	<link rel="stylesheet" type="text/css" href="//<?= CDN_DOMAIN ?>/css/gridster.min.css">
	<link rel="stylesheet" type="text/css" href="//<?= CDN_DOMAIN ?>/css/jquery-ui-1.12.1.min.css">
	<link rel="stylesheet" type="text/css" href="//<?= CDN_DOMAIN ?>/css/jquery-ui-custom.css?v=<?= VERSION ?>">
	<link rel="stylesheet" type="text/css" href="//<?= CDN_DOMAIN ?>/css/introjs.min.css">
	<link rel="stylesheet" type="text/css" href="//<?= CDN_DOMAIN ?>/css/app.min.css?v=<?= VERSION ?>">

	<title></title>
</head>
<?php flush(); ?>
<body class="transition">
	<div id="wrapper">
	<div id="inner-wrapper">
	<div id="topbar">
		<span class="align-left">
			<h1 id="logo">
				<a href="."><?= APP_NAME ?></a>
				<span id="version"><?= VERSION ?></span>
				<span>|</span>
				<!-- <span data-tooltip="System activity update countdown"><input id="APIclock" class="hidden" /></span> -->
			</h1>
			<h3 id="serverStatus" class="pointer" data-tooltip="EVE server status and player count">TQ: ??,???</h3>
			<h3 class="pointer" data-tooltip="EVE time (UTC)">| ET: <span id="serverTime">??.??</span></h3>
			<h3 id="systemSearch">| <i id="search" data-icon="search" data-tooltip="Toggle system search"></i>
				<span id="currentSpan" class="hidden"><span class="pointer">Current System: </span><span id="EVEsystem">?</span><i id="follow" data-icon="follow" data-tooltip="Follow my in-game system" style="padding-left: 10px;"></i></span>
				<span id="searchSpan"><form id="systemSearch" method="GET" action=".?"><input type="text" size="18" class="systemsAutocomplete" name="system" /></form></span>
				<span id="APItimer" class="hidden"></span>
			</h3>
		</span>
		<span class="align-right">
			<span id="login">
				<h3><a id="user" href=""><span id="user-no-track"><?= $_SESSION['characterName'] ?></span><span id="user-track" style="display:none"><i data-icon="follow" data-tooltip="Tracking"></i><span id="user-track-name">...</span></span></a></h3>
				<div id="panel">
					<div id="content" class="dialog-like">
						<div class="triangle"></div>

						<table id="logoutTable">
							<tr>
								<td>
									<table id="track">
										<tr><th colspan="2">Tracking</th></tr>
										<tr>
											<td id="tracking">
												<table id="tracking-clone" class="hidden">
													<tr>
														<td rowspan="5" class="avatar"><img src="" />
															<hr class="bar online critical" style="margin-bottom: 2px" data-tooltip="Online status" />
															<span class="control-group">
																<i data-icon="eye" class="show interactable" data-property="show" data-tooltip="Visible on chain"></i>
																<i data-icon="prop-mod" class="show-ship interactable" data-property="showShip" data-tooltip="Ship shown on chain"></i>
															</span>
														</td>
														<td class="name text">&nbsp;</td>
														<i data-icon="alert" class="alert hidden" data-tooltip="Re-add character to fix missing permissions"></i>
													</tr>
													<tr>
														<td class="system text">&nbsp;</td>
													</tr>
													<tr>
														<td class="station text" data-tooltip="">&nbsp;</td>
													</tr>
													<tr>
														<td class="ship text">&nbsp;</td>
													</tr>
													<tr>
														<td class="shipname text">&nbsp;</td>
													</tr>
												</table>
											</td>
										</tr>
									</table>
								</td>
								<td>
									<table id="account">
										<tr><th colspan="2">Characters</th></tr>
										<tr>
											<td id="avatar" rowspan="4"><img src="https://image.eveonline.com/Character/<?= $_SESSION['characterID'] ?>_64.jpg" /></td>
											<td id="characterName" class="text"><?= $_SESSION['characterName'] ?></td>
										</tr>
										<tr>
											<td class="text"><?= $_SESSION['corporationName'] ?></td>
										</tr>
										<tr><td rowspan="2"></td></tr>
									</table>
								</td>
							</tr>
							<tr>
								<td>
									<input type="button" value="Add" OnClick="javascript: window.location.href = 'login.php?mode=sso&login=esi'" />
									<input type="button" value="Remove" id="removeESI" disabled="disabled" />
								</td>
								<td colspan="1"><input id="logout" type="button" value="Logout" /></td>
							</tr>
						</table>
					</div>
				</div>
			</span>

			<h3> | </h3>
			<h3><a href="#" id="mask-menu-link" data-tooltip="Current mask"><span id="mask">(???)</span></a></h3>
			<div id="mask-menu" class="toggle-panel" style="right: 68px; top:34px; display:none">
				<div class="triangle"></div>
				<div id="mask-menu-mask-list"></div>
				<hr class="bar" />
				<a href="#" id="mask-link">Manage masks</a>
				<a href="#" id="admin"<?= checkAdmin($_SESSION['mask']) || checkOwner($_SESSION['mask']) ? '' : 'style="display: none"' ?>>Mask Admin</a>
			</div>
			<h3> | </h3>

			<i id="settings" style="font-size: 1.7em;" data-icon="settings" class="options" data-tooltip="Settings"></i>
			<i id="layout" style="font-size: 1.7em;" data-icon="layout" data-tooltip="Customize layout"></i>
		</span>
	</div>

	<div class="gridster">
		<ul>
			<li id="infoWidget" class="gridWidget" data-row="1" data-col="1" data-sizex="7" data-sizey="6" data-min-sizex="5" data-min-sizey="4" style="width: 410px; height: 350px;">
				<div class="controls">
					<div style="float: right;">
						<span id="favorite-control-wrapper"><!-- for tutorial -->
							<i id="system-favorite" data-icon="star-empty" data-tooltip="Add/Remove favorite"></i>
							<span id="favorite-dropdown-toggle" class="control" data-tooltip="Show all favorites">...</span>
						</span>
						<div id="favorite-panel" class="toggle-panel" style="right: 17px; display: none">
							<h4>Favorites</h4>
							<div id='favorite-panel-wrapper'>
								<p>Favorites loading ...</p>
							</div>
						</div>
						<span>|</span>
						<i class="tutorial" data-tooltip="Show tutorial for this section">?</i>
					</div>
				</div>
				<div class="content">
					<div id="infoGeneral" style="float: left; width: 50%; text-align: left;">
						<h1 class="pointer" style="color: #CCC;"><span id="infoSystem"><?=$system?></span><a class="copy" href="#" title="Copy system name"></a></h1>
						<h4 id="infoSecurity" class="pointer">&nbsp;</h4>
						<h4 id="infoRegion" class="pointer">&nbsp;</h4>
						<h4 id="infoFaction" class="pointer">&nbsp;</h4>
					</div>
					<div id="infoExtra" style="float: right; width: 50%; text-align: right;">
					</div>
					<br clear="all"/>
					<div id="activityGraph"></div>
					<div id="activityGraphControls" style="text-align: center;"><a href="javascript: activity.time(168);">Week</a> - <a href="javascript: activity.time(48);">48Hour</a> - <a href="javascript: activity.time(24);">24Hour</a></div>
					<div id="infoLinks" style="text-align: center;">
						<a class="infoLink" data-href="http://anoik.is/systems/$systemName" href="" target="_blank">Anoik.is</a> - 
						<a class="infoLink" data-href="https://evemaps.dotlan.net/search?q=$systemName" href="" target="_blank">dotlan</a> - 
						<a class="infoLink" data-href='https://zkillboard.com/system/$systemID/' href="" target="_blank">zKillboard</a>
					</div>
					<div id="infoStatics" class="pointer"></div>
				</div>
			</li>
			<li id="signaturesWidget" class="gridWidget" data-row="1" data-col="8" data-sizex="7" data-sizey="6" data-min-sizex="5" data-min-sizey="2" style="width: 410px; height: 350px;">
				<div class="controls">
					<i id="add-signature" data-icon="plus" data-tooltip="Add a new signature"></i>
					<i id="edit-signature" data-icon="edit" data-tooltip="Edit selected signature" class="disabled"></i>
					<i id="delete-signature" data-icon="trash" data-tooltip="Delete selected signature(s)" class="disabled"></i>
					<span>|</span>
					<i id="signature-count" style="font-style: normal; cursor: default;" data-tooltip="Total signature count">0</i>
					<i id="undo" data-icon="undo" class="disabled" data-tooltip="Undo last signature change"></i>
					<i id="redo" data-icon="redo" class="disabled" data-tooltip="Redo what was undone"></i>
					<div style="float: right;">
						<i id="toggle-automapper" class="disabled" data-icon="auto" data-tooltip="Toggle Auto-Mapper"></i>
						<i class="tutorial" data-tooltip="Show tutorial for this section">?</i>
					</div>
				</div>
				<div class="content">
					<div id="sigTableWrapper">
						<table id="sigTable" width="100%">
							<thead>
								<tr>
									<th class="sortable">ID<i data-icon=""></i></th>
									<th class="sortable">Type<i data-icon=""></i></th>
									<th class="sortable" data-sorter="usLongDate">Age<i data-icon=""></i></th>
									<th class="sortable">Leads To<i data-icon=""></i></th>
									<th class="sortable">Life<i data-icon=""></i></th>
									<th class="sortable">Mass<i data-icon=""></i></th>
								</tr>
							</thead>
							<tbody></tbody>
						</table>
					</div>
				</div>
			</li>
			<li id="notesWidget" class="gridWidget" data-row="1" data-col="15" data-sizex="7" data-sizey="6" data-min-sizex="5" data-min-sizey="2" style="width: 410px; height: 350px;">
				<div class="controls">
					<i id="add-comment" data-icon="plus" data-tooltip="Add a new comment"></i>
					<i id="comment-sort" data-icon="sort" data-tooltip="Sort comments by creation date"></i>
					<div style="float: right;">
						<i class="tutorial" data-tooltip="Show tutorial for this section">?</i>
					</div>
				</div>
				<div class="content" id="comment-outer-container">
					<div id="comment-container" style="display: flex"> <!-- https://stackoverflow.com/questions/36130760/use-justify-content-flex-end-and-to-have-vertical-scrollbar -->
						<div class="comment hidden">
							<div class="commentToolbar">
								<div class="commentTitle">
									<span class="commentModified"></span>
									<span class="commentCreated"></span>
									<i class="commentSticky" data-icon="pin" data-tooltip="Sticky"></i>
								</div>
								<div class="commentControls">
									<a class="commentEdit" href="">Edit</a>
									<a class="commentDelete" href="">Delete</a>
								</div>
								<div style="clear: both;"></div>
							</div>
							<div id="" class="commentBody"></div>
							<div class="commentFooter hidden">
								<div class="commentStatus"></div>
								<div class="commentControls">
									<a href="" class="commentSave">Save</a>
									<a href="" class="commentCancel">Cancel</a>
								</div>
								<div style="clear: both;"></div>
							</div>
						</div>
					</div>
				</div>
			</li>
			<li id="chainWidget" class="gridWidget" data-row="7" data-col="1" data-sizex="21" data-sizey="8" data-min-sizex="5" data-min-sizey="4" style="width: 1250px; height: 470px;">
				<div class="controls">
					<span id="chainTabs"></span>
					<i id="newTab" data-icon="plus" data-tooltip="New tab"></i>
					<span>|</span>
					<i id="show-viewing" data-icon="eye" data-tooltip="Add viewing system to chain"></i>
					<i id="show-favorite" data-icon="star" data-tooltip="Add favorite systems to chain"></i>
					<i id="show-chainLegend" data-tooltip="<table id='guide'>
						<tr><td><div class='guide stable'></td><td>Stable</td><th>Auras</th></tr>
						<tr><td><div class='guide eol'></div></td><td>End of Life</td><td><div class='guide aura jm-5kt frig'></div></td><td>Small</td></tr>
						<tr><td><div class='guide destab'></div></td><td>Mass Destabbed</td><td><div class='guide aura jm-62kt'></div></td><td>Medium</td></tr>
						<tr><td><div class='guide critical'></div></td><td>Mass Critical</td><td><div class='guide aura jm-375kt'></div></td><td>Large</td></tr>
						<tr><td><div class='guide frig'></div></td><td>Frigate</td><td><div class='guide aura jm-2000kt'></div></td><td>X-Large</td></tr>
					</table>">&equiv;</i>
					<span>|</span>
					<i id="hot-jump" data-icon="prop-mod" data-tooltip="Jumping hot (prop on)"></i>
					<i id="higgs-jump" data-icon="anchor" data-tooltip="Higgs Anchor fitted"></i>
					<div style="float: right;">
						<button id="chain-zoom-reset" class="hidden">Reset Zoom</button>
						<!-- <i class="tutorial" data-tooltip="Show tutorial for this section">?</i> -->
					</div>
				</div>
				<div id="chainParent" class="content dragscroll">
					<div style="position: relative; display: table; width: 100%;">
						<table id="chainGrid">
							<tr class="top"><td></td></tr>
							<tr class="space hidden"><td></td></tr>
							<tr class="line hidden"><td></td></tr>
							<tr class="space hidden"><td>1</td></tr>
							<tr class="line hidden"><td></td></tr>
							<tr class="space hidden"><td>2</td></tr>
							<tr class="line hidden"><td></td></tr>
							<tr class="space hidden"><td>3</td></tr>
							<tr class="line hidden"><td></td></tr>
							<tr class="space hidden"><td>4</td></tr>
							<tr class="line hidden"><td></td></tr>
							<tr class="space hidden"><td>5</td></tr>
							<tr class="line hidden"><td></td></tr>
							<tr class="space hidden"><td>6</td></tr>
							<tr class="line hidden"><td></td></tr>
							<tr class="space hidden"><td>7</td></tr>
							<tr class="line hidden"><td></td></tr>
							<tr class="space hidden"><td>8</td></tr>
							<tr class="line hidden"><td></td></tr>
							<tr class="space hidden"><td>9</td></tr>
							<tr class="line hidden"><td></td></tr>
							<tr class="space hidden"><td>10</td></tr>
							<tr class="line hidden"><td></td></tr>
							<tr class="space hidden"><td>11</td></tr>
							<tr class="line hidden"><td></td></tr>
							<tr class="space hidden"><td>12</td></tr>
							<tr class="line hidden"><td></td></tr>
							<tr class="space hidden"><td>13</td></tr>
							<tr class="line hidden"><td></td></tr>
							<tr class="space hidden"><td>14</td></tr>
							<tr class="line hidden"><td></td></tr>
							<tr class="space hidden"><td>15</td></tr>
							<tr class="line hidden"><td></td></tr>
							<tr class="space hidden"><td>16</td></tr>
							<tr class="line hidden"><td></td></tr>
							<tr class="space hidden"><td>17</td></tr>
							<tr class="line hidden"><td></td></tr>
							<tr class="space hidden"><td>18</td></tr>
							<tr class="line hidden"><td></td></tr>
							<tr class="space hidden"><td>19</td></tr>
							<tr class="line hidden"><td></td></tr>
							<tr class="space hidden"><td>20</td></tr>
							<tr class="line hidden"><td></td></tr>
							<tr class="space hidden"><td>21</td></tr>
							<tr class="line hidden"><td></td></tr>
							<tr class="space hidden"><td>22</td></tr>
						</table>
						<div id="chainMap"></div>
					</div>
				</div>
				<div id="menuContainer" style="position:absolute">
					<ul id="chainMenu" class="hidden">
						<!-- <li data-command="showInfo"><a>Show Info</a> -->
						<li><a>Navigation</a>
							<ul style="width: 10em;">
								<li data-command="setDest"><a>Set Destination</a></li>
								<li data-command="addWay"><a>Add Waypoint</a></li>
								<li>-</li>
								<li data-command="setDestAll"><a>Set Destination (All Tracked)</a></li>
								<li data-command="addWayAll"><a>Add Waypoint (All Tracked)</a></li>		
							</ul>
						</li>
						<li>
							<li><a>Flares</a>
								<ul style="width: 10em;">
									<li data-command="red"><a>Battle (red)</a></li>
									<li data-command="yellow"><a>Hold (yellow)</a></li>
									<li data-command="green"><a>Fleet Op (green)</a></li>
								</ul>
							</li>
							<li data-command="mass"><a>Mass</a></li>
							<li data-command="collapse"><a>Collapse</a></li>
							<li data-command="ping"><a>Ping ...</a></li>
							<li data-command="copySystemName"><a id="copySystemNameMenuItem">[Copy system name]</a></li>
							<li data-command="makeTab"><a id="makeTabMenuItem">[makeTab]</a></li>
						</li>
					</ul>				
				</div>
			</li>
		</ul>
	</div>

	<div id="footer">
		<?php include 'donation_panel.inc'; ?>
		<?php printf("<span id='pageTime'>Page generated in %.3f seconds.</span>", microtime(true) - $startTime); ?>
		<p>All Eve Related Materials are Property Of <a href="https://www.ccpgames.com" target="_blank">CCP Games</a></p>
		<p id="legal" class="pointer">EVE Online and the EVE logo are the registered trademarks of CCP hf. All rights are reserved worldwide. All other trademarks are the property of their respective owners. EVE Online, the EVE logo, EVE and all associated logos and designs are the intellectual property of CCP hf. All artwork, screenshots, characters, vehicles, storylines, world facts or other recognizable features of the intellectual property relating to these trademarks are likewise the intellectual property of CCP hf. CCP is in no way responsible for the content on or functioning of this website, nor can it be liable for any damage arising from the use of this website.</p>
	</div>
	</div>
	</div>

	<div id="dialog-deleteComment" title="Delete Comment" class="hidden">
		<i data-icon="alert"></i> This comment will be removed. Are you sure?
	</div>

	<div id="dialog-deleteSig" title="Delete Signature(s)" class="hidden">
		<i data-icon="alert"></i> <span id="deleteSigText">This signature</span> will be removed from <span id="deleteSigSystem">this system</span>. Are you sure?
	</div>

	<div id="dialog-signature" title="Add Signature" class="hidden">
		<form id="form-signature" autocomplete="off">
			<input autocomplete="false" name="hidden" type="text" class="hidden" />
			<div class="row">
				<span class="label">ID:</span>
				<input name="signatureID_Alpha" type="text" maxlength="3" size="2" class="signatureID" autocomplete="off" />
				<span class="label">-</span>
				<input name="signatureID_Numeric" type="text" maxlength="3" size="2" placeholder="###" class="signatureID" autocomplete="off" />
				<span id="signatureType" class="select">
					<select name="signatureType">
						<option value="unknown">Unknown</option>
						<option value="combat">Combat</option>
						<option value="wormhole">Wormhole</option>
						<option value="ore">Ore</option>
						<option value="data">Data</option>
						<option value="gas">Gas</option>
						<option value="relic">Relic</option>
					</select>
				</span>
			</div>
			<div class="row">
				<span class="label">Length:</span>
				<input type="text" value="" name="signatureLength" id="durationPicker" />
			</div>
			<div id="site">
				<div id="signatureName" class="row">
					<span class="label">Name:</span>
					<span><input name="signatureName" type="text" maxlength="100" autocomplete="off" /></span>
				</div>
			</div>
			<div id="wormhole" class="hidden">
				<div class="side">
					<div class="sideLabel"></div>
					<div class="row">
						<span class="label">Type:</span>
						<span data-autocomplete="sigTypeFrom">
							<input name="wormholeType" type="text" class="wormholeType" maxlength="4" size="4" autocomplete="off" />
						</span>
						<span id="wormholeTypeQuickSelectFrom" class="wormholeTypeQuickSelect quickSelectBar"></span>
						<!-- <span class="bookmark">
							<span class="label">BM:</span>
							<input name="" type="text" maxlength="10" size="8" />
						</span> -->
					</div>
					<div class="row">
						<span class="label">Leads:</span>
						<span data-autocomplete="sigSystems">
							<input name="leadsTo" type="text" maxlength="20" size="20" class="leadsTo" autocomplete="off" />
							<select>
								<!-- Values filled in by signature dialog JS -->
							</select>
						</span>
						<!-- needs to not be whitespace between the buttons for alignment, even though it's ugly markup -->
						<div id="leadsToQuickBar" class="quickSelectBar"><button type="button" class="quick-select" value="Class-1" tabindex="-1"><span class="class-1">C1<span></button><button type="button" class="quick-select" value="Class-2" tabindex="-1"><span class="class-2">C2<span></button><button type="button" class="quick-select" value="Class-3" tabindex="-1"><span class="class-3">C3<span></button><button type="button" class="quick-select" value="Class-4" tabindex="-1"><span class="class-4">C4<span></button><button type="button" class="quick-select" value="Class-5" tabindex="-1"><span class="class-5">C5<span></button><button type="button" class="quick-select" value="Class-6" tabindex="-1"><span class="class-6">C6<span></button> |
						<button type="button" class="quick-select" value="High-Sec" tabindex="-1"><span class="hisec">HS<span></button><button type="button" class="quick-select" value="Low-Sec" tabindex="-1"><span class="lowsec">LS<span></button><button type="button" class="quick-select" value="Null-Sec" tabindex="-1"><span class="nullsec">NS<span></button>
						</div>
					</div>
					<div class="row">
						<span class="label">Name:</span>
						<input name="wormholeName" type="text" maxlength="100" size="20" autocomplete="off" />
					</div>
					<div class="row">
						<span class="label">Life:</span>
						<input type="radio" class="mini-selector" name="wormholeLife" id="wormholeLifeStable"  value="stable"/>
						<label for="wormholeLifeStable" class="stable">Stable</label>
						<input type="radio" class="mini-selector" name="wormholeLife" id="wormholeLifeEOL"  value="critical"/>
						<label for="wormholeLifeEOL" class="critical">EOL</label>
					</div>
					<div class="row">
						<span class="label">Mass:</span>
						<input type="radio" class="mini-selector" name="wormholeMass" id="wormholeMassStable"  value="stable"/>
						<label for="wormholeMassStable" class="stable">Stable</label>
						<input type="radio" class="mini-selector" name="wormholeMass" id="wormholeMassDestab" value="destab"/>
						<label for="wormholeMassDestab" class="destab">Destab</label>
						<input type="radio" class="mini-selector" name="wormholeMass" id="wormholeMassCritical" value="critical" />
						<label for="wormholeMassCritical" class="critical">Critical</label>
					</div>
				</div>
				<hr/>
				<div class="side">
					<div class="sideLabel"></div>
					<div class="row">
						<span class="label">ID:</span>
						<input name="signatureID2_Alpha" type="text" maxlength="3" size="2" class="signatureID" autocomplete="off" />
						<span class="label">-</span>
						<input name="signatureID2_Numeric" type="text" maxlength="3" size="2" placeholder="###" class="signatureID" autocomplete="off" />
					</div>
					<div class="row">
						<span class="label">Type:</span>
						<span data-autocomplete="sigTypeTo">
							<input name="wormholeType2" type="text" class="wormholeType" data-autocomplete="sigType" maxlength="4" size="4" autocomplete="off" />
						</span>
						<span id="wormholeTypeQuickSelectTo" class="wormholeTypeQuickSelect quickSelectBar"></span>
						<!-- <span class="bookmark">
							<span class="label">BM:</span>
							<input name="" type="text" maxlength="10" size="8" />
						</span> -->
					</div>
					<div class="row">
						<span class="label">Name:</span>
						<input name="wormholeName2" type="text" maxlength="100" size="20" autocomplete="off" />
					</div>
				</div>
			</div>
			<input type="submit" style="position: absolute; left: -99999px;" tabindex="-1" />
		</form>
	</div>

	<div id="dialog-admin" title="Mask Admin" class="hidden">
		<div style="height: 100%;">
			<div class="menu">
				<!-- menu -->
				<ul>
					<li data-window="default" class="active"><a href="#">Home</a></li>
					<li data-window="active-users" data-refresh="3000"><a href="#">Active Users</a></li>
					<li data-window="user-stats"><a href="#">User Stats</a></li>
					<li data-window="access-list"><a href="#">Access List</a></li>
				</ul>
			</div>
			<div class="window">
				<!-- window -->
				<div data-window="default">
					<h1>Welcome to the new Mask Admin feature!</h1>
					<br/>
					<p>This has been a long overdue feature, but thanks to the continued requests over the months I was finally able to make enough progress to have a first release.</p>
					<br/>
					<p>There may be a few minor bugs with the interface yet, I spent most of the time making sure the back-end security was solid so nobody saw users they shouldn't be. Also I was the only one testing this feature for opsec sake</p>
					<br/>
					<p>Please feel free to suggest additions, I plan to add many more menu items over the next few weeks but telling me what you all want will help me prioritize and make sure I don't overlook something useful</p>
					<br/>
					<ul>
						<li>Mask creators/owners get access to mask admin</li>
						<li>Custom corp masks the creating corp admins get access</li>
						<li>Works for the default private and corporate masks</li>
					</ul>
					<br/>
					<p>Thanks for using Tripwire, enjoy! :)</p>
				</div>
				<div data-window="active-users" class="hidden">
					<table data-sortable="true" width="100%" cellpadding="0" cellspacing="0">
						<thead>
							<tr>
								<th class="sortable">Account<i data-icon=""></i></th>
								<th class="sortable">Character<i data-icon=""></i></th>
								<th class="sortable">System<i data-icon=""></i></th>
								<th class="sortable">Ship Name<i data-icon=""></i></th>
								<th class="sortable">Ship Type<i data-icon=""></i></th>
								<th class="sortable">Station<i data-icon=""></i></th>
							</tr>
						</thead>
						<tbody>
							<tr class="hidden">
								<td data-col="accountCharacterName"></td>
								<td data-col="characterName"></td>
								<td data-col="systemName"></td>
								<td data-col="shipName"></td>
								<td data-col="shipTypeName"></td>
								<td data-col="stationName"></td>
							</tr>
						</tbody>
					</table>
				</div>
				<div data-window="user-stats" class="hidden">
					<table data-sortable="true" width="100%" cellpadding="0" cellspacing="0">
						<thead>
							<tr>
								<th colspan="2"></th>
								<th colspan="3">Signatures</th>
								<th colspan="3">Wormholes</th>
								<th colspan="3">Comments</th>
								<th colspan="3"></th>
							</tr>
							<tr>
								<th class="sortable">Character<i data-icon=""></i></th>
								<th class="sortable">Corporation<i data-icon=""></i></th>
								<th class="sortable">Added<i data-icon=""></i></th>
								<th class="sortable">Updated<i data-icon=""></i></th>
								<th class="sortable">Deleted<i data-icon=""></i></th>
								<th class="sortable">Added<i data-icon=""></i></th>
								<th class="sortable">Updated<i data-icon=""></i></th>
								<th class="sortable">Deleted<i data-icon=""></i></th>
								<th class="sortable">Added<i data-icon=""></i></th>
								<th class="sortable">Updated<i data-icon=""></i></th>
								<th class="sortable">Deleted<i data-icon=""></i></th>
								<th class="sortable"># of Logins<i data-icon=""></i></th>
								<th class="sortable">Last Login<i data-icon=""></i></th>
							</tr>
						</thead>
						<tbody>
							<tr class="hidden">
								<td data-col="characterName"></td>
								<td data-col="corporationName"></td>
								<td data-col="signatures_added" data-format="number" class="text-center"></td>
								<td data-col="signatures_updated" data-format="number" class="text-center"></td>
								<td data-col="signatures_deleted" data-format="number" class="text-center"></td>
								<td data-col="wormholes_added" data-format="number" class="text-center"></td>
								<td data-col="wormholes_updated" data-format="number" class="text-center"></td>
								<td data-col="wormholes_deleted" data-format="number" class="text-center"></td>
								<td data-col="comments_added" data-format="number" class="text-center"></td>
								<td data-col="comments_updated" data-format="number" class="text-center"></td>
								<td data-col="comments_deleted" data-format="number" class="text-center"></td>
								<td data-col="logins" data-format="number" class="text-center"></td>
								<td data-col="lastLogin" class="text-center"></td>
							</tr>
						</tbody>
					</table>
				</div>
				<div data-window="access-list" class="hidden">
					<table data-sortable="true" width="100%" cellpadding="0" cellspacing="0">
						<thead>
							<tr>
								<th class="sortable">Character<i data-icon=""></i></th>
								<th class="sortable">Corporation<i data-icon=""></i></th>
								<th class="sortable">Date added<i data-icon=""></i></th>
							</tr>
						</thead>
						<tbody>
							<tr class="hidden">
								<td data-col="characterName"></td>
								<td data-col="corporationName"></td>
								<td data-col="added" class="text-center"></td>
							</tr>
						</tbody>
					</table>
				</div>
			</div>
		</div>
	</div>
	
	<div id="dialog-masks" title="Masks" class="hidden">
		<div id="masks">
			<div class="maskCategory">
				<div class="maskCategoryLabel">Default</div>
				<div id="default"></div>
			</div>
			<div class="maskCategory">
				<div class="maskCategoryLabel">I Own</div>
				<div id="owned"></div>
			</div>
			<div class="maskCategory">
				<div class="maskCategoryLabel">I'm Invited</div>
				<div id="invited"></div>
			</div>
		</div>
		<div id="maskControls">
				<input type="button" id="edit" value="Edit" />
				<input type="button" id="delete" value="Delete" />
		</div>		
		<div id="mask-explanation"><p>The mask source icons <span class="mask"><i data-icon="eye" class="global" data-tooltip="Global mask, visible to everyone"></i>, <i data-icon="user" class="character" data-tooltip="Personal mask, managed by the owner"></i>, <i data-icon="star" class="corporate" data-tooltip="Corporate mask, managed by corp admins"></i>, <i data-icon="star" class="alliance"data-tooltip="Alliance mask"></i></span> show where the mask comes from.</p>
		<p>The colour of the bar on the mask preview shows how you are invited to it: grey, green or blue for being invited personally, through your corp or through your alliance. Only corp admins can add/remove corp-joined masks from the quick switch.</p>
		</div>
	</div>

	<div id="dialog-options" title="Settings" class="hidden">
		<div id="optionsAccordion">
			<h3><a href="#">Account Settings</a></h3>
			<div>
				<table class="optionsTable" width="100%" cellpadding="1" cellspacing="0">
					<tr>
						<th>Username:</th>
						<td id="username"></td>
					</tr>
					<tr>
						<th colspan="2">Characters:</th>
					</tr>
					<tr>
						<th colspan="2" id="characters"></th>
					</tr>

				</table>
				<div style="border-top: 1px solid black; text-align: right; margin: 0 -5px; padding: 5px 5px 0 5px;">
					<input type="button" id="usernameChange" value="Change Username" />
					<input type="button" id="pwChange" value="Change Password" />
				</div>
			</div>
			<h3><a href="#">Chain Map Settings</a></h3>
			<div>
				<table class="optionsTable" width="100%" cellpadding="1" cellspacing="0">
					<tr>
						<th>Chain Renderer:</th>
						<td>
							<select id="renderer">
								<option value="orgChartTop">New Org Chart (System at top)</option>
								<option value="orgChartSide">New Org Chart (System at left)</option>
								<option value="radial">Radial (System in middle)</option>
								<option value="orgChart">Old legacy org chart</option>
							</select>
						</td>
					</tr>
					<tr>
						<th>Show Chain Map Gridlines:</th>
						<td>
							<input type="radio" name="gridlines" id="gridlines-yes" value="true" /><label for="gridlines-yes"> Yes</label>
							<input type="radio" name="gridlines" id="gridlines-no" value="false" /><label for="gridlines-no"> No</label>
						</td>
					</tr>
					<tr>
						<th>Show Line Aura*:</th>
						<td>
							<input type="radio" name="aura" id="aura-yes" value="true" /><label for="aura-yes"> Yes</label>
							<input type="radio" name="aura" id="aura-no" value="false" /><label for="aura-no"> No</label>
						</td>
					</tr>
					<tr>
						<th>Line Weight Factor*:</th>
						<td>
							<label for="node-spacing-line-weight-slider"></label><div id="node-spacing-line-weight-slider" class="spacing-slider"></div>
						</td>
					</tr>
					<tr>
						<th>Allow Scroll Without Ctrl Key:</th>
						<td>
							<input type="radio" name="scrollWithoutCtrl" id="scrollWithoutCtrl-yes" value="true" /><label for="scrollWithoutCtrl-yes"> Yes</label>
							<input type="radio" name="scrollWithoutCtrl" id="scrollWithoutCtrl-no" value="false" /><label for="scrollWithoutCtrl-no"> No</label>
						</td>
					</tr>
					<tr>
						<th>Chain Map Node Reference:</th>
						<td>
							<input type="radio" name="node-reference" id="node-reference-type" value="type" /><label for="node-reference-type"> Wormhole Type</label>
							<input type="radio" name="node-reference" id="node-reference-id" value="id" /><label for="node-reference-id"> Signature ID</label>
						</td>
					</tr>
					<tr>
						<th>Show sig name on map:</th>
						<td>
							<select id="chainSigNameLocation">
								<option value="name">System name - replace</option>
								<option value="name_prefix">System name - prefix</option>
								<option value="ref">Reference - replace</option>
								<option value="ref_prefix">Reference - prefix</option>
								<option value="none">Don't put it on the map</option>
							</select>
						</td>
					</tr>
					<tr>
						<th>Node Spacing Factor*:</th>
						<td>
							X: <label for="node-spacing-x-slider"></label><div id="node-spacing-x-slider" class="spacing-slider"></div><br/>
							Y: <label for="node-spacing-y-slider"></label><div id="node-spacing-y-slider" class="spacing-slider"></div>
						</td>
					</tr>
					<tr><td colspan=2 style="font-size: 80%; text-align: left">*: No effect in old org chart renderer</td></tr>
				</table>
			</div>
			<h3><a href="#">General Preferences</a></h3>
			<div>
				<table class="optionsTable" width="100%" cellpadding="1" cellspacing="0">
					<tr>
						<th>Show Route as Blobs up to:</th>
						<td>
							<select id="chainRoutingLimit">
								<option value="0">Off</option>
								<option value="5">5 Jumps</option>
								<option value="10">10 Jumps</option>
								<option value="15">15 Jumps</option>
								<option value="20">20 Jumps</option>
								<option value="1000">Entire Cluster</option>
							</select>
						</td>
					</tr>
					<tr>
						<th>K-space route selection:</th>
						<td>
							<select id="chainRouteSecurity" style="width: 30%">
								<option value="shortest">Shortest</option>
								<option value="highsec">Prefer HS</option>
								<option value="avoid-null">Avoid NS</option>
								<option value="avoid-high">Avoid HS</option>
							</select> <label><input type="checkbox" name="route-ignore-enabled" id="route-ignore-enabled">Avoiding:</label> <input type="text" style="width: 30%" name="route-ignore" id="route-ignore" />
						</td>
					</tr>				
					<tr>
						<th>Signature Add Dialog default type:</th>
						<td>
							<select id="editType">
								<option value="unknown">Unknown</option>
								<option value="combat">Combat</option>
								<option value="wormhole">Wormhole</option>
								<option value="ore">Ore</option>
								<option value="data">Data</option>
								<option value="gas">Gas</option>
								<option value="relic">Relic</option>
							</select>
						</td>
					<tr>
						<th>Signature paste default life:</th>
						<td>
							<select id="pasteLife">
								<option value="24">24 Hours</option>
								<option value="48">48 Hours</option>
								<option value="72">72 Hours</option>
								<option value="168">7 Days</option>
								<option value="672">28 Days</option>
							</select>
						</td>
					</tr>
					<tr>
						<th>Signature copy output separator:</th>
						<td>
							<input type="text" id="copySeparator" maxlength="20" />
						</td>
					</tr>
					<tr>
						<th>Background Image:</th>
						<td>
							<input type="text" id="background-image" maxlength="200" />
						</td>
					</tr>
					<tr>
						<th>UI Scale:</th>
						<td>
							<label for="uiscale-slider"></label>
							<div id="uiscale-slider"></div>
						</td>
					</tr>
				</table>
			</div>
			<h3><a href="#">Personal Statistics</a></h3>
			<div>
				<table class="optionsTable" width="100%" cellpadding="1" cellspacing="0">
					<tr>
						<th>Signatures added:</th>
						<td id="signatures_added"></td>
					</tr>
					<tr>
						<th>Signatures updated:</th>
						<td id="signatures_updated"></td>
					</tr>
					<tr>
						<th>Signatures deleted:</th>
						<td id="signatures_deleted"></td>
					</tr>
					<tr>
						<th>Wormholes added:</th>
						<td id="wormholes_added"></td>
					</tr>
					<tr>
						<th>Wormholes updated:</th>
						<td id="wormholes_updated"></td>
					</tr>
					<tr>
						<th>Wormholes deleted:</th>
						<td id="wormholes_deleted"></td>
					</tr>
					<tr>
						<th>Comments added:</th>
						<td id="comments_added"></td>
					</tr>
					<tr>
						<th>Comments updated:</th>
						<td id="comments_updated"></td>
					</tr>
					<tr>
						<th>Comments deleted:</th>
						<td id="comments_deleted"></td>
					</tr>
					<tr>
						<th>Systems visited:</th>
						<td id="systems_visited"></td>
					</tr>
					<tr>
						<th>Logins:</th>
						<td id="logins"></td>
					</tr>
					<tr>
						<th>Last login:</th>
						<td id="lastLogin"></td>
					</tr>
				</table>
			</div>
		</div>
	</div>

	<div id="dialog-usernameChange" title="Change Username" class="hidden">
		<form id="usernameForm">
			<table class="optionsTable" width="100%" cellpadding="1" cellspacing="0">
				<tr>
					<th>Current Username:</th>
					<td id="username"></td>
				</tr>
				<tr>
					<th>New Username:</th>
					<td><input type="text" name="username" size="16" maxlength="25" /></td>
				</tr>
			</table>
			<p id="usernameError" class="critical hidden"></p>
		</form>
	</div>

	<div id="dialog-pwChange" title="Change Password" class="hidden">
		<form id="pwForm">
			<table class="optionsTable" width="100%" cellpadding="1" cellspacing="0">
				<tr>
					<th>New Password:</th>
					<td><input type="password" name="password" maxlength="35" /></td>
				</tr>
				<tr>
					<th>Confirm:</th>
					<td><input type="password" name="confirm" maxlength="35" /></td>
				</tr>
			</table>
			<p id="pwError" class="critical hidden"></p>
		</form>
	</div>

	<div id="dialog-createMask" title="Create Mask" class="hidden">
		<form>
			<input type="hidden" name="mode" value="create" />
			<table class="optionsTable" width="100%" cellpadding="1" cellspacing="0">
				<tr>
					<th>Mask Name:</th>
					<td><input type="text" name="name" maxlength="100" /></td>
				</tr>
				<tr>
					<th>Mask Type:</th>
					<td>
						<select name="type">
							<option value="char">Character</option>
							<option value="corp">Corporate</option>
						</select>
					</td>
				</tr>
				<tr>
					<th colspan="2">Who has access:</th>
				</tr>
				<tr>
					<th colspan="2" id="accessList">
						<input type="checkbox" onclick="return false" id="create_add" value="" class="selector static">
						<label for="create_add" style="width: 100%; margin-left: -5px;" class="static">
							<i data-icon="plus" style="font-size: 3em; margin: 16px 0 0 16px; display: block;" class="static"></i>
						</label>
					</th>
				</tr>
			</table>
		</form>
	</div>

	<div id="dialog-editMask" title="Edit Mask" class="hidden">
		<form>
			<input type="hidden" name="mode" value="save" />
			<input type="hidden" name="mask" value="" />
			<table class="optionsTable" width="100%" cellpadding="1" cellspacing="0">
				<tr>
					<th>Mask Name:</th>
					<td id="name"></td>
				</tr>
				<tr>
					<th colspan="2">Who has access:</th>
				</tr>
				<tr>
					<th colspan="2">
						<div id="loading" style="text-align: center; padding-top: 10px; margin-left: -50px;">
							Getting API data...
							<span style="position: absolute; margin-top: -10px; padding-left: 25px;" class="" id="searchSpinner">
								<!-- Loading animation container -->
								<div class="loading">
								    <!-- We make this div spin -->
								    <div class="spinner">
								        <!-- Mask of the quarter of circle -->
								        <div class="mask">
								            <!-- Inner masked circle -->
								            <div class="maskedCircle"></div>
								        </div>
								    </div>
								</div>
							</span>
						</div>
						<div id="accessList">
							<input type="checkbox" onclick="return false" id="edit_add" value="" class="selector static">
							<label for="edit_add" class="static">
								<i data-icon="plus" style="font-size: 3em; margin: 16px 0 0 16px; display: block;" class="static"></i>
							</label>
						</div>
					</th>
				</tr>
			</table>
		</form>
	</div>

	<div id="dialog-joinMask" title="Find Mask" class="hidden">
		<form>
			<input type="hidden" name="mode" value="find" />
			<input type="hidden" name="find" value="" />
			<table class="optionsTable" width="100%" cellpadding="1" cellspacing="0">
				<tr>
					<th>Mask Name:</th>
					<td><input type="text" name="name" /></td>
				</tr>
				<tr>
					<td colspan="2">
						<span style="position: absolute; left: 15px;" class="hidden" id="loading">
							<!-- Loading animation container -->
							<div class="loading">
							    <!-- We make this div spin -->
							    <div class="spinner">
							        <!-- Mask of the quarter of circle -->
							        <div class="mask">
							            <!-- Inner masked circle -->
							            <div class="maskedCircle"></div>
							        </div>
							    </div>
							</div>
						</span>
						<input type="submit" value="Search" />
					</td>
				</tr>
				<tr>
					<th colspan="2">
						<div id="results"></div>
					</th>
				</tr>
			</table>
		</form>
	</div>

	<div id="dialog-EVEsearch" title="Search" class="hidden">
		<form id="EVEsearch">
			<input type="hidden" name="mode" value="search" />
			<table class="optionsTable" width="100%" cellpadding="1" cellspacing="0">
				<tr>
					<th>Search:</th>
					<td><input type="text" name="name" maxlength="50" /></td>
				</tr>
				<tr>
					<td colspan="2">
						<input type="checkbox" value="character" name="category" id="characterSearch" checked="checked"/>
						<label for="characterSearch">Character</label>
						<input type="checkbox" value="corporation" name="category" id="corporationSearch" checked="checked" />
						<label for="corporationSearch">Corporation</label>
						<input type="checkbox" value="alliance" name="category" id="allianceSearch" checked="checked" />
						<label for="allianceSearch">Alliance</label>
						<br/>
						<input type="checkbox" value="exact" name="exact" id="exactSearch" />
						<label for="exactSearch">Exact Match</label>
					</td>
				</tr>
				<tr>
					<td colspan="2">
						<span style="position: absolute; left: 15px;" class="hidden" id="searchSpinner">
							<!-- Loading animation container -->
							<div class="loading">
							    <!-- We make this div spin -->
							    <div class="spinner">
							        <!-- Mask of the quarter of circle -->
							        <div class="mask">
							            <!-- Inner masked circle -->
							            <div class="maskedCircle"></div>
							        </div>
							    </div>
							</div>
						</span>
						<span style="position: absolute; left: 15px; text-align: left;" id="searchCount"></span>
						<input type="submit" value="Search" />
					</td>
				</tr>
				<tr>
					<th colspan="2">
						<div id="EVESearchResults"></div>
					</th>
				</tr>
			</table>
		</form>
	</div>

	<div id="dialog-api" title="Access via API" class="hidden">
		<form id="reset_form">
			<span data-icon="alert"></span> You must use an API Key from the character you registered with.<br/><br/>
			<div style="font-style: italic; clear: both;">* Do not use multi-character APIs</div>
			<br/>
			<a href="https://support.eveonline.com/api" target="_blank" tabindex="-1">View your EVE API keys</a>
			<br/><br/>
			<table class="stdTable">
				<tr><th>Key ID:</th><td><input type=text id="keyID" size="8" maxlength="12" /></td></tr>
				<tr><th>vCode:</th><td><input type=text id="vCode" maxlength="100" style="box-sizing: border-box; width: 100%;" /></td></tr>
			</table>
		</form>
	</div>

	<div id="dialog-mass" title="" class="hidden">
		<p><span id="mass-systems">-</span><span id="mass-placeholder-desc" data-tooltip="Based on system types.<br>Enter the actual hole type in the Edit Signature panel for accurate mass values."> (Inferred hole type)</span></p>
		<p>Total recorded: <b id="mass-jumped">?</b> of ~<span id="mass-capacity">?</span> [<span data-tooltip="Wormhole mass can be ±10%, and there might be unrecorded jumps.">?</span>]</p>
		<p>Show jumps down to: 
			<label><input type="radio" name="show-mass" value="capital"> Capital only</label>
			<label><input type="radio" name="show-mass" value="battleship"> Battleships</label>
			<label><input type="radio" name="show-mass" value="cruiser"> Cruisers</label>
			<label><input type="radio" name="show-mass" value="all" checked> All jumps</label>
		</p>
		<div id="massTableContainer"><table id="massTable">
			<thead>
				<tr>
					<th>Character</th>
					<th>Direction</th>
					<th>Ship Type</th>
					<th>Mass [<span data-tooltip="Hot jumps <i data-icon=prop-mod></i> add prop mod (50kt except for caps) to mass<br>Higgs <i data-icon=anchor></i> doubles jump mass">?</span>]</th>
					<th>Time</th>
				</tr>
			</thead>
			<tbody></tbody>
		</table></div>
	</div>

	<div id="dialog-ping" title="" class="hidden" style="width:300px">
		<form id="ping_form">
			<p>Enter information about why you're pinging the system. You don't need to include the system name, Tripwire will add system information to the message.</p>
			<textarea id="ping-text" style="width:100%; margin-left: 0; margin-top: 8px; height: 150px"></textarea>
		</form>
	</div>

	<div id="dialog-newTab" title="New Tab" class="hidden">
		<form id="newTab_form">
			<table class="optionsTable" width="100%" cellpadding="1" cellspacing="0">
				<tr>
					<th>Name:</th><td><input type="text" class="name" maxlength="20" size="20" /></td>
				</tr>
				<tr>
					<th>System:</th><td><input type="radio" name="tabType" id="tabType1" checked="checked" style="vertical-align: text-top;" /><input type="text" class="sigSystemsAutocomplete" size="20" /></td>
				</tr>
				<tr>
					<th></th><td><input type="radio" name="tabType" id="tabType2" style="vertical-align: middle;" /><label for="tabType2" style="width: 164px; display: inline-block; padding-left: 2px; text-align: left;">&nbsp;K-Space</label></td>
				</tr>
				<tr>
					<th></th><td><input type="checkbox" id="tabThera" /><label for="tabThera">Include EVE-Scout's Thera chain</label></td>
				</tr>
			</table>
			<input type="submit" style="position: absolute; left: -9999px"/>
		</form>
	</div>

	<div id="dialog-editTab" title="Edit Tab" class="hidden">
		<form id="editTab_form">
			<table class="optionsTable" width="100%" cellpadding="1" cellspacing="0">
				<tr>
					<th>Name:</th>
					<td><input type="text" class="name" maxlength="20" size="20" /></td>
				</tr>
				<tr>
					<th>System:</th>
					<td><input type="radio" name="tabType" id="editTabType1" checked="checked" style="vertical-align: text-top;" /><input type="text" class="sigSystemsAutocomplete" size="20" /></td>
				</tr>
				<tr>
					<th></th>
					<td><input type="radio" name="tabType" id="editTabType2" style="vertical-align: middle;" /><label for="editTabType2" style="width: 164px; display: inline-block; padding-left: 2px; text-align: left;">&nbsp;K-Space</label></td>
				</tr>
				<tr>
					<th></th>
					<td><input type="checkbox" id="editTabThera" /><label for="editTabThera">Include EVE-Scout's Thera chain</label></td>
				</tr>
			</table>
			<input type="submit" style="position: absolute; left: -9999px"/>
		</form>
	</div>

	<div id="dialog-select-signature" title="&nbsp;" class="hidden return-invisible">
			Jumping from <span id="select-sig-from">[from]</span> to <span id="select-sig-to">[to].</span>
			<br>Which signature would you like to update?<br/><br/>
			<table class="optionsTable" width="100%" cellpadding="1" cellspacing="0">
					<thead>
							<tr>
									<th></th>
									<th class="centerAlign">ID</th>
									<th class="centerAlign">Type</th>
									<th class="centerAlign">Leads To</th>
									<th class="centerAlign">Life</th>
									<th class="centerAlign">Mass</th>
							</tr>
					</thead>
					<tbody></tbody>
			</table>
	</div>

	<div id="dialog-error" title="Error" class="hidden">
		<span data-icon="alert" class="critical"></span>
		<span id="msg"></span>
	</div>

	<div id="dialog-msg" title="&nbsp;" class="hidden">
		<span data-icon="info"></span>
		<span id="msg"></span>
	</div>

	<div id="dialog-confirm" title="&nbsp;" class="hidden">
		<span data-icon="info"></span>
		<span id="msg"></span>
	</div>

	<ul id="signatureColumnMenu" class="hidden">
		<li data-command="leftAlign"><a>Left align</a></li>
		<li data-command="centerAlign"><a>Center align</a></li>
		<li data-command="rightAlign"><a>Right align</a></li>
	</ul>

	<div id="chainTab" class="hidden">
		<span class="tab">
			<span class="name" data-tab=""></span>
			<i class="closeTab" data-icon="times"></i>
			<i class="editTab" data-icon="edit"></i>
		</span>
	</div>

	<div id="chainNode" class="hidden">
		<div class="nodeIcons">
			<div style="float: left;">
				<i class="whEffect invisible"></i>
			</div>
			<div style="float: right;">
				<i data-icon="user" class="invisible confused"></i>
				<span class="badge invisible"></span>
			</div>
		</div>
		<h4 class="nodeClass">??</h4>
		<h4 class="nodeSystem"><a href="" class="invisible">system</a></h4>
		<h4 class="nodeType">&nbsp;</h4>
		<div class="nodeActivity">
			<span class="jumps invisible">&#9679;</span>&nbsp;<span class="pods invisible">&#9679;</span>&nbsp;&nbsp;<span class="ships invisible">&#9679;</span>&nbsp;<span class="npcs invisible">&#9679;</span>
		</div>
	</div>

	<textarea id="clipboard"></textarea>

	<?php
		$analytics_file = dirname( __FILE__ ) . "/analytics.inc.php";
		if ( file_exists( $analytics_file ) ) include_once( $analytics_file );
		$init_fields = [
			'characterID' => $_SESSION['characterID'],
			'characterName' => $_SESSION['characterName'],
			'options' => $_SESSION['options']
		];
	?>

	<script type="text/javascript">
		const init = <?= json_encode($init_fields) ?>;
		init.masks = <?= json_encode(getMasks($_SESSION['characterID'], $_SESSION['corporationID'], $_SESSION['admin'], $_SESSION['mask'])) ?>;

		var passiveHitTimer;
		function passiveHit() {
			ga('send', 'pageview');
			clearTimeout(passiveHitTimer);
			passiveHitTimer = setTimeout("passiveHit()", 240000);
		}

		setTimeout("passiveHit()", 240000);

		// Monitor event listeners
		var listenerCount = 0;
		(function() {
		    var ael = Node.prototype.addEventListener;
		    Node.prototype.addEventListener = function() {
		         listenerCount++;
		         ael.apply(this, arguments);
		    }
		    var rel = Node.prototype.removeEventListener;
		    Node.prototype.removeEventListener = function() {
		         listenerCount--;
		         rel.apply(this, arguments);
		    }
		})();

	</script>

	<!-- JS Includes -->
	<script type="text/javascript" src="//<?= CDN_DOMAIN ?>/js/jquery-3.3.1.min.js"></script>
	<script type="text/javascript" src="//<?= CDN_DOMAIN ?>/js/jquery-ui-1.12.1.min.js"></script>
	<script type="text/javascript" src="//<?= CDN_DOMAIN ?>/js/jquery.tablesorter.combined.min.js"></script>
	<script type="text/javascript" src="//<?= CDN_DOMAIN ?>/js/jquery.ui-contextmenu.min.js"></script>
	<script type="text/javascript" src="//<?= CDN_DOMAIN ?>/js/jquery.plugin.min.js"></script>
	<script type="text/javascript" src="//<?= CDN_DOMAIN ?>/js/jquery.countdown.js"></script>
	<script type="text/javascript" src="//<?= CDN_DOMAIN ?>/js/jquery.gridster.min.js"></script>
	<script type="text/javascript" src="//<?= CDN_DOMAIN ?>/js/jquery.knob.min.js"></script>
	<script type="text/javascript" src="//<?= CDN_DOMAIN ?>/js/jquery.jbox-0.4.9.min.js"></script>
	<script type="text/javascript" src="//<?= CDN_DOMAIN ?>/js/jquery.jbox-notice-0.4.9.min.js"></script>
	<script type="text/javascript" src="//<?= CDN_DOMAIN ?>/js/jquery.duration-picker.js"></script>
	<script type="text/javascript" src="//<?= CDN_DOMAIN ?>/ckeditor/ckeditor.js"></script>
	<script type="text/javascript" src="//<?= CDN_DOMAIN ?>/js/dragscroll.js"></script>
	<script type="text/javascript" src="//<?= CDN_DOMAIN ?>/js/lodash.js"></script>
	<script type="text/javascript" src="https://www.gstatic.com/charts/loader.js"></script>
	<!-- Google Charts -->
	<script type="text/javascript">google.charts.load('current', {packages: ['corechart', 'orgchart']});</script>
	<script type="text/javascript" src="//<?= CDN_DOMAIN ?>/js/moment.min.js"></script>
	<script type="text/javascript" src="//<?= CDN_DOMAIN ?>/js/intro.min.js"></script>
	<script type="text/javascript" src="//<?= CDN_DOMAIN ?>/js/combine.js?v=<?= VERSION ?>"></script>
	<script type="text/javascript" src="//<?= CDN_DOMAIN ?>/js/app.min.js?v=<?= VERSION ?>"></script>
	<!-- JS Includes -->
</body>
</html>
