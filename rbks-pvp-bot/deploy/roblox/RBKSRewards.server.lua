--[[
	RBKS PVP - livraison des recompenses /rewards (Script serveur)

	A placer dans ServerScriptService (Script, pas LocalScript).
	Prerequis dans Roblox Studio : Game Settings > Security > "Enable Studio Access to API Services"
	pour tester en Studio.

	Le bot Discord ecrit, pour chaque joueur relie, la liste de ses recompenses debloquees dans le
	DataStore "RBKSRewards" (cle = UserId du joueur). Ce script les lit a la connexion du joueur
	(et en direct si le joueur est deja en jeu), donne celles qu'il n'a pas encore recues et memorise
	ce qui a ete donne pour ne jamais donner deux fois la meme recompense.

	A FAIRE : remplir la table REWARDS ci-dessous avec ce que chaque recompense donne dans ton jeu.
	Les identifiants (ex. "title_genin") sont ceux que tu choisis dans le panel du bot > Recompenses.
]]

local DataStoreService = game:GetService("DataStoreService")
local MessagingService = game:GetService("MessagingService")
local Players = game:GetService("Players")

local REWARDS_STORE = DataStoreService:GetDataStore("RBKSRewards") -- ecrit par le bot (meme nom que ROBLOX_DATASTORE)
local GRANTED_STORE = DataStoreService:GetDataStore("RBKSRewardsGranted") -- recompenses deja donnees
local TOPIC = "RBKSRewards" -- meme nom que ROBLOX_MESSAGING_TOPIC

-- Ce que donne chaque recompense. Exemple : a adapter a ton jeu (monnaie, titres, objets...).
local REWARDS = {
	["title_genin"] = function(player)
		-- TonSystemeDeTitres:Donner(player, "Genin")
	end,
	["ryo_500"] = function(player)
		-- TonSystemeDeMonnaie:Ajouter(player, 500)
	end,
}

local busy = {}

local function deliver(player)
	if busy[player.UserId] then return end
	busy[player.UserId] = true
	local key = tostring(player.UserId)

	local okData, data = pcall(function()
		return REWARDS_STORE:GetAsync(key)
	end)
	if not okData or type(data) ~= "table" or type(data.rewards) ~= "table" then
		busy[player.UserId] = nil
		return
	end

	local okGranted, granted = pcall(function()
		return GRANTED_STORE:GetAsync(key)
	end)
	if not okGranted then -- en cas d'erreur, on ne donne rien (on reessaiera plus tard)
		busy[player.UserId] = nil
		return
	end
	granted = type(granted) == "table" and granted or {}

	local newOnes = {}
	for _, rewardId in ipairs(data.rewards) do
		if not granted[rewardId] then
			local give = REWARDS[rewardId]
			if give then
				local ok, err = pcall(give, player)
				if ok then
					granted[rewardId] = os.time()
					table.insert(newOnes, rewardId)
				else
					warn("[RBKSRewards] " .. rewardId .. " : " .. tostring(err))
				end
			else
				warn("[RBKSRewards] Recompense inconnue dans la table REWARDS : " .. tostring(rewardId))
			end
		end
	end

	if #newOnes > 0 then
		pcall(function()
			GRANTED_STORE:SetAsync(key, granted, { player.UserId })
		end)
		print(("[RBKSRewards] %s a recu : %s"):format(player.Name, table.concat(newOnes, ", ")))
	end
	busy[player.UserId] = nil
end

Players.PlayerAdded:Connect(deliver)
for _, p in ipairs(Players:GetPlayers()) do
	task.spawn(deliver, p)
end

-- Livraison en direct quand le bot debloque une recompense pour un joueur deja connecte.
pcall(function()
	MessagingService:SubscribeAsync(TOPIC, function(message)
		local player = Players:GetPlayerByUserId(tonumber(message.Data) or 0)
		if player then
			task.wait(2)
			deliver(player)
		end
	end)
end)
